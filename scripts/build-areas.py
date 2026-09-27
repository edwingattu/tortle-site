"""Build Tortle semantic-tile packs from raw boundary downloads.

Reads raw_geo/*, simplifies, assigns hierarchy (ward->district->state->country
->continent, city = districts containing wards), and emits compact JSON packs
to app/data/*.json. One-off build step; outputs are committed.

Sources / licences (see raw_geo/ATTRIBUTION):
- GHMC wards: datameet/Municipal_Spatial_Data (OSM-derived)
- Telangana districts: datta07/INDIAN-SHAPEFILES (33 districts)
- India states: GADM 4.1 level 1
- Countries: world-atlas 110m TopoJSON (Natural Earth)
- Country->continent: lukes/ISO-3166-Countries-with-Regional-Codes
"""
import csv
import json
import math
import sys

RAW = 'raw_geo'
OUT = 'app/data'

CONTINENT_LABELS = {
    'Asia': [100.0, 34.0],
    'Europe': [15.0, 54.0],
    'Africa': [20.0, 5.0],
    'North America': [-100.0, 45.0],
    'South America': [-60.0, -15.0],
    'Oceania': [140.0, -28.0],
    'Antarctica': [0.0, -80.0],
}

STATE_PRETTY = {
    'AndamanandNicobar': 'Andaman & Nicobar',
    'DadraandNagarHaveliandDamanandDiu': 'Dadra Nagar Haveli, Daman & Diu',
    'JammuandKashmir': 'Jammu & Kashmir',
    'NCT of Delhi': 'Delhi',
}


def decode_topo(topo, obj_name):
    """Minimal TopoJSON decoder -> list of (props, id, multipoly)."""
    obj = topo['objects'][obj_name]
    arcs = topo['arcs']
    tr = topo.get('transform')
    if tr:
        kx, ky, dx, dy = tr['scale'][0], tr['scale'][1], tr['translate'][0], tr['translate'][1]
    decoded = []

    def arc_points(i):
        pts = []
        x = y = 0
        for dx_, dy_ in arcs[i if i >= 0 else ~i]:
            x += dx_
            y += dy_
            pts.append([x, y])
        if i < 0:
            pts.reverse()
        if tr:
            pts = [[p[0] * kx + dx, p[1] * ky + dy] for p in pts]
        return pts

    def ring(indices):
        pts = []
        for i in indices:
            ap = arc_points(i)
            pts.extend(ap if not pts else ap[1:])
        return pts

    geoms = []
    for g in obj['geometries']:
        t = g['type']
        if t == 'Polygon':
            geoms.append((g.get('properties', {}), g.get('id'),
                          [[ring(r) for r in g['arcs']]]))
        elif t == 'MultiPolygon':
            geoms.append((g.get('properties', {}), g.get('id'),
                          [[ring(r) for r in poly] for poly in g['arcs']]))
    return geoms


def ring_area(r):
    s = 0.0
    for i in range(len(r) - 1):
        s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return s / 2.0


def polygon_area(polys):
    return sum(abs(ring_area(r)) for poly in polys for r in poly)


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


def point_in_ring(x, y, r):
    inside = False
    j = len(r) - 1
    for i in range(len(r)):
        xi, yi = r[i]
        xj, yj = r[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polys(x, y, polys):
    for poly in polys:
        for r in poly:
            if point_in_ring(x, y, r):
                return True
    return False


def bbox_of(polys):
    xs = [p[0] for poly in polys for r in poly for p in r]
    ys = [p[1] for poly in polys for r in poly for p in r]
    return (min(xs), min(ys), max(xs), max(ys))


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


def ward_name(props):
    raw = props.get('name', '')
    if raw.lower().startswith('ward '):
        parts = raw.split(' ', 2)
        if len(parts) == 3:
            return parts[2].strip()
    return raw or 'Unnamed ward'


def main():
    # ---- load ----
    wards = json.load(open(f'{RAW}/ghmc-wards.geojson'))['features']
    districts = json.load(open(f'{RAW}/tg-districts-33.geojson'))['features']
    states = json.load(open(f'{RAW}/india-states-gadm.json'))['features']
    topo = json.load(open(f'{RAW}/countries-110m.json'))
    countries = decode_topo(topo, 'countries')

    iso = {}
    with open(f'{RAW}/iso-regions.csv') as f:
        for row in csv.DictReader(f):
            try:
                iso[int(row['country-code'])] = row
            except ValueError:
                continue

    # ---- simplify + normalize ----
    ward_items = []
    for i, feat in enumerate(wards):
        mp = simplify_polys(as_multipoly(feat['geometry']), 4, 1e-10)
        if not mp:
            continue
        name = ward_name(feat['properties'])
        ward_items.append({'id': f'wd-{i}', 'name': name, 'polys': mp,
                           'c': centroid_of(mp), 'bbox': bbox_of(mp)})

    dist_items = []
    for feat in districts:
        mp = simplify_polys(as_multipoly(feat['geometry']), 3, 1e-7)
        if not mp:
            continue
        name = str(feat['properties'].get('dtname', '')).title()
        dist_items.append({'id': f"dt-{feat['properties'].get('Dist_LGD', name)}",
                           'name': name or 'Unnamed district', 'polys': mp,
                           'c': centroid_of(mp), 'bbox': bbox_of(mp)})

    state_items = []
    for feat in states:
        mp = simplify_polys(as_multipoly(feat['geometry']), 2, 1e-5)
        if not mp:
            continue
        raw = feat['properties'].get('NAME_1', '')
        name = STATE_PRETTY.get(raw, raw)
        state_items.append({'id': f"st-{feat['properties'].get('GID_1', name)}",
                            'name': name, 'polys': mp,
                            'c': centroid_of(mp), 'bbox': bbox_of(mp)})

    country_items = []
    # Disputed territories carry no ISO numeric id in 110m; keep them as
    # permanently unclaimed with hand-assigned continents.
    DISPUTED = {'Kosovo': 'Europe', 'N. Cyprus': 'Asia', 'Somaliland': 'Africa',
                'Norway': 'Europe', 'France': 'Europe'}
    for props, gid, mp_raw in countries:
        mp = simplify_polys(mp_raw, 2, 1e-6)
        if not mp:
            continue
        name = props.get('name', '')
        try:
            num = int(gid)
            if num < 0:
                raise ValueError
        except (TypeError, ValueError):
            if name not in DISPUTED:
                continue
            num = None
        row = iso.get(num, {}) if num is not None else {}
        region = row.get('region', '')
        sub = row.get('sub-region', '')
        a2 = row.get('alpha-2', '')
        if name in DISPUTED and not row:
            cont = DISPUTED[name]
        elif a2 == 'AQ':
            cont = 'Antarctica'
        elif region == 'Americas':
            cont = 'North America' if sub in ('Northern America', 'Central America', 'Caribbean') else 'South America'
        else:
            cont = region or 'Other'
        cid = f'cn-{num}' if num is not None else f"cn-x-{name.lower().replace(' ', '').replace('.', '')}"
        country_items.append({'id': cid, 'name': name,
                              'iso': a2, 'continent': cont, 'polys': mp,
                              'c': centroid_of(mp), 'bbox': bbox_of(mp)})

    # ---- hierarchy by centroid containment ----
    def find_parent(pt, items):
        x, y = pt
        for it in items:
            bx0, by0, bx1, by1 = it['bbox']
            if not (bx0 <= x <= bx1 and by0 <= y <= by1):
                continue
            if point_in_polys(x, y, it['polys']):
                return it['id']
        return None

    telangana = next((s for s in state_items if 'telangana' in s['name'].lower()), None)
    if not telangana:
        sys.exit('Telangana not found in states pack')
    for d in dist_items:
        d['parent'] = find_parent(d['c'], state_items) or telangana['id']
    for s in state_items:
        s['parent'] = 'cn-356'  # India
    india = next((c for c in country_items if c['id'] == 'cn-356'), None)
    if not india:
        sys.exit('India (356) not found in countries pack')

    ward_no_parent = 0
    for w in ward_items:
        p = find_parent(w['c'], dist_items)
        if not p:
            ward_no_parent += 1
            # nearest district bbox center fallback
            best, best_d = None, 1e18
            for d in dist_items:
                bx0, by0, bx1, by1 = d['bbox']
                cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
                dd = (cx - w['c'][0]) ** 2 + (cy - w['c'][1]) ** 2
                if dd < best_d:
                    best_d, best = dd, d['id']
            p = best
        w['parent'] = p

    city_members = sorted({w['parent'] for w in ward_items})
    cx = sum(d['c'][0] for d in dist_items if d['id'] in city_members) / len(city_members)
    cy = sum(d['c'][1] for d in dist_items if d['id'] in city_members) / len(city_members)
    city = {'id': 'city-hyderabad', 'name': 'Hyderabad', 'members': city_members, 'c': [cx, cy]}

    # ---- emit ----
    import os
    os.makedirs(OUT, exist_ok=True)

    def pack(items, extra=()):
        out = []
        for it in items:
            e = {'id': it['id'], 'name': it['name'], 'parent': it.get('parent'),
                 'c': [round(it['c'][0], 4), round(it['c'][1], 4)],
                 'polys': it['polys']}
            for k in extra:
                e[k] = it.get(k)
            out.append(e)
        return out

    packs = {
        'areas': pack(ward_items),
        'districts': pack(dist_items),
        'states': pack(state_items),
        'countries': pack(country_items, extra=('continent',)),
    }
    for name, items in packs.items():
        with open(f'{OUT}/{name}.json', 'w') as f:
            json.dump(items, f, separators=(',', ':'))
    meta = {
        'city': city,
        'continents': [{'id': f'cont-{k}', 'name': k, 'c': v} for k, v in CONTINENT_LABELS.items()],
        'levels': [
            {'level': 'area', 'anchor': 12.5, 'band': [11.5, 12.5]},
            {'level': 'district', 'anchor': 10.5, 'band': [9.5, 11.5]},
            {'level': 'city', 'anchor': 8.5, 'band': [7.5, 9.5]},
            {'level': 'state', 'anchor': 6.5, 'band': [5.5, 7.5]},
            {'level': 'country', 'anchor': 4.5, 'band': [3.5, 5.5]},
            {'level': 'continent', 'anchor': 2.5, 'band': [0, 3.5]},
        ],
        'areaUnlockFraction': 0.3,
        'areaUnlockMin': 2,
    }
    with open(f'{OUT}/meta.json', 'w') as f:
        json.dump(meta, f, separators=(',', ':'), indent=None)

    import os as _os
    sizes = {n: _os.path.getsize(f'{OUT}/{n}.json') for n in list(packs) + ['meta']}
    print(json.dumps({
        'wards': len(ward_items), 'wards_no_parent': ward_no_parent,
        'districts': len(dist_items), 'states': len(state_items),
        'countries': len(country_items), 'city_members': city_members,
        'telangana': telangana['id'], 'sizes': sizes,
    }, indent=1))


main()
