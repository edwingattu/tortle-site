"""Build Tortle NYC semantic-tile packs from raw boundary downloads.

Reads raw_geo/nta-2020.geojson (NYC Open Data, DCP), raw_geo/nyc-boroughs.geojson
(NYC Open Data, DCP), raw_geo/usa-states-gadm.json (GADM 4.1 level 1) and emits
compact JSON packs to app/data/nyc/*.json. Appends NY state to the global
app/data/states.json (parent cn-840 USA, already in countries.json).
One-off build step; outputs are committed. Same schema as build-areas.py.

Sources / licences:
- NTAs + boroughs: NYC Open Data, Dept. of City Planning (license unspecified —
  credit "NYC Department of City Planning / NYC Open Data" in-app).
- NY state: GADM 4.1 (free for academic / non-commercial use framing).
"""
import json
import os

RAW = 'raw_geo'
OUT = 'app/data/nyc'

NY_STATE_ID = 'st-newyork'
USA_ID = 'cn-840'


def ring_area(r):
    s = 0.0
    for i in range(len(r) - 1):
        s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return s / 2.0


def centroid_of(polys):
    best, best_a = None, -1
    for poly in polys:
        for r in poly:
            a = abs(ring_area(r))
            if a > best_a:
                best_a, best = a, r
    if not best:
        return [0.0, 0.0]
    n = len(best)
    return [sum(p[0] for p in best) / n, sum(p[1] for p in best) / n]


def simplify_ring(ring, dec, tol):
    pts = []
    for x, y in ring:
        p = (round(x, dec), round(y, dec))
        if not pts or p != pts[-1]:
            pts.append(p)
    if len(pts) > 2 and pts[0] == pts[-1]:
        pass
    elif pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    # Strip exactly-collinear middles: rounding can collapse a thin triangle
    # into a zero-area sliver, which H3's polyfill rejects outright.
    if len(pts) > 4:
        keep = [pts[0]]
        for i in range(1, len(pts) - 1):
            x0, y0 = keep[-1]
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            if abs((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1)) < 1e-15:
                continue
            keep.append(pts[i])
        keep.append(pts[-1])
        pts = keep
    if len(pts) <= 4:
        return [[float(a), float(b)] for a, b in pts]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        x0, y0 = out[-1]
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        cross = abs((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1))
        if cross >= tol:
            out.append(pts[i])
    out.append(pts[-1])
    if len(out) < 4:
        return [[float(a), float(b)] for a, b in pts[:4]]
    return [[float(a), float(b)] for a, b in out]


def simplify_polys(polys, dec, tol):
    out = []
    for poly in polys:
        rings = []
        for r in poly:
            s = simplify_ring(r, dec, tol)
            if len(s) >= 4:
                rings.append(s)
        if rings:
            out.append(rings)
    return out


def as_multipoly(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    return geom['coordinates']


def main():
    ntas = json.load(open(f'{RAW}/nta-2020.geojson'))['features']
    boroughs = json.load(open(f'{RAW}/nyc-boroughs.geojson'))['features']
    states = json.load(open(f'{RAW}/usa-states-gadm.json'))['features']
    ny = next(f for f in states if f['properties'].get('NAME_1') == 'NewYork')

    # ---- boroughs (districts) ----
    boro_items = []
    boro_by_name = {}
    for feat in boroughs:
        mp = simplify_polys(as_multipoly(feat['geometry']), 3, 1e-7)
        if not mp:
            continue
        name = feat['properties'].get('boroname', '')
        code = str(feat['properties'].get('borocode', name))
        item = {'id': f'bo-{code}', 'name': name or f'Borough {code}',
                'parent': NY_STATE_ID, 'polys': mp, 'c': centroid_of(mp)}
        boro_items.append(item)
        boro_by_name[name] = item['id']
    assert len(boro_items) == 5, f'expected 5 boroughs, got {len(boro_items)}'

    # ---- NTAs (areas) ----
    nta_items = []
    orphan = 0
    for feat in ntas:
        mp = simplify_polys(as_multipoly(feat['geometry']), 3, 1e-7)
        if not mp:
            continue
        props = feat['properties']
        code = (props.get('nta2020') or '').lower()
        name = props.get('ntaname') or code or 'Unnamed NTA'
        parent = boro_by_name.get(props.get('boroname'))
        if not parent:
            orphan += 1
        nta_items.append({'id': f'nta-{code}' if code else f'nta-x-{len(nta_items)}',
                          'name': name, 'parent': parent,
                          'polys': mp, 'c': centroid_of(mp)})
    assert orphan == 0, f'{orphan} NTAs without a borough parent'

    # ---- NY state (global pack) ----
    ny_mp = simplify_polys(as_multipoly(ny['geometry']), 2, 1e-5)
    ny_item = {'id': NY_STATE_ID, 'name': 'New York', 'parent': USA_ID,
               'c': [round(v, 4) for v in centroid_of(ny_mp)], 'polys': ny_mp}

    # ---- city = NTA union; center = mean of borough centroids (the union's
    # largest single ring can be an outlying water body — never use it).
    city = {'id': 'city-newyork', 'name': 'New York',
            'members': sorted(boro_by_name.values()),
            'c': [round(sum(b['c'][0] for b in boro_items) / len(boro_items), 4),
                  round(sum(b['c'][1] for b in boro_items) / len(boro_items), 4)]}

    # ---- emit ----
    os.makedirs(OUT, exist_ok=True)

    def pack(items):
        return [{'id': it['id'], 'name': it['name'], 'parent': it.get('parent'),
                 'c': [round(it['c'][0], 4), round(it['c'][1], 4)],
                 'polys': it['polys']} for it in items]

    packs = {'areas': pack(nta_items), 'districts': pack(boro_items)}
    for name, items in packs.items():
        with open(f'{OUT}/{name}.json', 'w') as f:
            json.dump(items, f, separators=(',', ':'))
    with open(f'{OUT}/meta.json', 'w') as f:
        json.dump({'city': city}, f, separators=(',', ':'))

    states_path = 'app/data/states.json'
    states_pack = json.load(open(states_path))
    states_pack = [s for s in states_pack if s['id'] != NY_STATE_ID]
    states_pack.append(ny_item)
    with open(states_path, 'w') as f:
        json.dump(states_pack, f, separators=(',', ':'))

    sizes = {n: os.path.getsize(f'{OUT}/{n}.json') for n in list(packs) + ['meta']}
    sizes['states.json'] = os.path.getsize(states_path)
    print(json.dumps({
        'ntas': len(nta_items), 'orphans': orphan,
        'boroughs': [b['name'] for b in boro_items],
        'city_center': city['c'], 'sizes': sizes,
    }, indent=1))


main()
