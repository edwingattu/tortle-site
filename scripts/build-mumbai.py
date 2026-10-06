"""Build Tortle Mumbai packs from MCGM boundary downloads.

Reads raw_geo/mumbai-prabhags-2022.geojson (236 electoral prabhags -> areas)
and raw_geo/mumbai-admin-wards.geojson (24 admin wards -> districts), assigns
prabhag->ward parents by centroid containment, and emits compact JSON packs
to app/data/bom/{meta,areas,districts}.json. One-off build step; outputs are
committed. City/state/country/continent tiers reuse the global packs.

Sources / licences (see raw_geo/ATTRIBUTION):
- MCGM admin wards + 2022 prabhags: sanjanakrishnan/mumbai_spatial_data
  (MCGM-sourced, CC BY 4.0)
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'build_areas', os.path.join(HERE, 'build-areas.py'))
build_areas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_areas)

RAW = 'raw_geo'
OUT = 'app/data/bom'


def main():
    prabhags = json.load(open(f'{RAW}/mumbai-prabhags-2022.geojson'))['features']
    wards = json.load(open(f'{RAW}/mumbai-admin-wards.geojson'))['features']

    ward_items = []
    for feat in wards:
        mp = build_areas.simplify_polys(
            build_areas.as_multipoly(feat['geometry']), 3, 1e-7)
        if not mp:
            continue
        name = str(feat['properties'].get('name', '')).strip() or 'Unnamed'
        wid = 'bm-w-' + name.replace('/', '-').replace(' ', '')
        ward_items.append({'id': wid, 'name': f'Ward {name}', 'polys': mp,
                           'c': build_areas.centroid_of(mp),
                           'bbox': build_areas.bbox_of(mp)})

    prab_items = []
    for feat in prabhags:
        mp = build_areas.simplify_polys(
            build_areas.as_multipoly(feat['geometry']), 4, 1e-10)
        if not mp:
            continue
        n = feat['properties'].get('prabhag')
        try:
            n = int(n)
        except (TypeError, ValueError):
            continue
        prab_items.append({'id': f'bm-p-{n}', 'name': f'Prabhag {n}',
                           'polys': mp,
                           'c': build_areas.centroid_of(mp),
                           'bbox': build_areas.bbox_of(mp)})

    def find_parent(pt, items):
        x, y = pt
        for it in items:
            bx0, by0, bx1, by1 = it['bbox']
            if not (bx0 <= x <= bx1 and by0 <= y <= by1):
                continue
            if build_areas.point_in_polys(x, y, it['polys']):
                return it['id']
        return None

    no_parent = 0
    for p in prab_items:
        q = find_parent(p['c'], ward_items)
        if not q:
            no_parent += 1
            best, best_d = None, 1e18
            for d in ward_items:
                bx0, by0, bx1, by1 = d['bbox']
                cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
                dd = (cx - p['c'][0]) ** 2 + (cy - p['c'][1]) ** 2
                if dd < best_d:
                    best_d, best = dd, d['id']
            q = best
        p['parent'] = q

    members = sorted({w['parent'] for w in prab_items})
    mcenters = [d['c'] for d in ward_items if d['id'] in members]
    cx = sum(c[0] for c in mcenters) / len(mcenters)
    cy = sum(c[1] for c in mcenters) / len(mcenters)
    city = {'id': 'city-mumbai', 'name': 'Mumbai',
            'members': members, 'c': [cx, cy]}
    # Districts roll up to Maharashtra (GADM IND.20_1) so the state lights up.
    maharashtra = 'st-IND.20_1'
    for d in ward_items:
        d['parent'] = maharashtra

    def pack(items):
        return [{'id': it['id'], 'name': it['name'],
                 'parent': it.get('parent'),
                 'c': [round(it['c'][0], 4), round(it['c'][1], 4)],
                 'polys': it['polys']} for it in items]

    os.makedirs(OUT, exist_ok=True)
    with open(f'{OUT}/areas.json', 'w') as f:
        json.dump(pack(prab_items), f, separators=(',', ':'))
    with open(f'{OUT}/districts.json', 'w') as f:
        json.dump(pack(ward_items), f, separators=(',', ':'))
    with open(f'{OUT}/meta.json', 'w') as f:
        json.dump({'city': city}, f, separators=(',', ':'))

    print(f'prabhags={len(prab_items)} wards={len(ward_items)} '
          f'no_parent={no_parent} city_members={len(members)}')


if __name__ == '__main__':
    sys.exit(main())
