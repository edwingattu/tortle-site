// Tortle quest 3D: hovering amber prisms over launched quest tiles.
// Three.js lives behind a dynamic import so a CDN failure degrades to the
// flat 2D look instead of breaking the map. One shared custom layer, one
// pooled cast — never one scene per tile.
//
// Coordinates are map mercator units straight (x east, y south, z up), which
// is exactly what the custom-layer matrix expects — so footprints are built
// in meters with negated Y and scaled once per frame.

const THREE_URL = 'https://esm.sh/three@0.161.0';
const MAX_CAST = 60; // launched tiles per region stay far below this
const PRISM_DEPTH_M = 48; // extrusion thickness, meters — must read at street zoom
const HOVER_GAP_M = 30; // clear gap between flat tile and prism base
const BOUNCE_AMP_M = 6; // gentle hover amplitude
const BOUNCE_PERIOD_MS = 2600;

export function createQuestTiles3D(map, { boundaryFor, cellCenter }) {
  // Staged boot status Heavy diagnostics live here (not swallowed):
  // read window.__quest3d in the console (?debug=1) to see where it stops.
  const status = {
    stage: 'init',
    error: null,
    cellCount: 0,
    meshCount: 0,
    renderFrames: 0,
  };
  try { window.__quest3d = status; } catch {}
  function mark(stage, err) {
    status.stage = stage;
    if (err !== undefined) status.error = String((err && err.message) || err);
    try { console.log('[quest3d]', stage, status.error || ''); } catch {}
  }
  let THREE = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let group = null;
  let material = null;
  let pendingCells = [];
  let needsRebuild = false;

  const api = {
    ready: false,
    failed: false,
    setCells(cells) {
      pendingCells = Array.isArray(cells) ? cells.slice(0, MAX_CAST) : [];
      status.cellCount = pendingCells.length;
      needsRebuild = true;
    },
  };

  function mercatorScale(lat) {
    try {
      return 1 / (40075016 * Math.cos((lat * Math.PI) / 180));
    } catch {
      return 1 / 40075016;
    }
  }

  function centerMercator(c) {
    const x = (c.lng + 180) / 360;
    const sin = Math.sin((c.lat * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return { x, y };
  }

  function rebuild() {
    if (!THREE || !group) return;
    while (group.children.length) {
      const child = group.children.pop();
      try { child.geometry?.dispose?.(); } catch {}
      try { group.remove(child); } catch {}
    }
    for (const cell of pendingCells) {
      let ring = null;
      let center = null;
      try { ring = boundaryFor(cell); } catch {}
      try { center = cellCenter(cell); } catch {}
      if (!ring || ring.length < 4 || !center) continue;
      try {
        // Exact hex footprint in meters, Y negated into mercator handedness.
        const mPerDegLng = 111320 * Math.cos((center.lat * Math.PI) / 180);
        const mPerDegLat = 110540;
        const shape = new THREE.Shape();
        for (let i = 0; i < ring.length; i++) {
          const x = (ring[i][0] - center.lng) * mPerDegLng;
          const y = -((ring[i][1] - center.lat) * mPerDegLat);
          if (i === 0) shape.moveTo(x, y);
          else shape.lineTo(x, y);
        }
        const geo = new THREE.ExtrudeGeometry(shape, { depth: PRISM_DEPTH_M, bevelEnabled: false });
        const mesh = new THREE.Mesh(geo, material);
        mesh.userData.center = center;
        mesh.userData.phase = Math.random() * Math.PI * 2; // desync bounce
        group.add(mesh);
      } catch {}
    }
    needsRebuild = false;
  }

  function placeMesh(mesh, now) {
    const c = mesh.userData.center;
    const s = mercatorScale(c.lat);
    const p = centerMercator(c);
    const hover =
      (HOVER_GAP_M +
        Math.sin((now / BOUNCE_PERIOD_MS) * Math.PI * 2 + mesh.userData.phase) * BOUNCE_AMP_M) *
      s;
    mesh.position.set(p.x, p.y, hover);
    mesh.scale.setScalar(s);
  }

  async function boot() {
    mark('import-start');
    try {
      const mod = await import(/* @vite-ignore */ THREE_URL);
      THREE = mod.default ?? mod;
      mark('import-ok');
    } catch (err) {
      api.failed = true;
      mark('import-fail', err);
      return;
    }
    try {
      map.addLayer({
        id: 'quest-tiles-3d',
        type: 'custom',
        renderingMode: '3d',
        onAdd(m, gl) {
          try {
            renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true, alpha: true });
            renderer.autoClear = false;
            scene = new THREE.Scene();
            camera = new THREE.Camera();
            scene.add(new THREE.HemisphereLight(0xfff6e0, 0x1d242e, 1.1));
            const dir = new THREE.DirectionalLight(0xffffff, 0.9);
            dir.position.set(0.5, 1, 0.8);
            scene.add(dir);
            material = new THREE.MeshLambertMaterial({
              color: 0xffd98a,
              emissive: 0x7a4d12,
              emissiveIntensity: 0.55,
            });
            group = new THREE.Group();
            scene.add(group);
            mark('layer-ok');
          } catch (err) {
            mark('renderer-fail', err);
            throw err;
          }
        },
        render(gl, matrix) {
          try {
            if (!renderer) return;
            if (needsRebuild) rebuild();
            status.meshCount = group ? group.children.length : 0;
            if (!group.children.length) return; // nothing hovering, no loop
            const now = performance.now();
            for (const child of group.children) placeMesh(child, now);
            camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);
            renderer.resetState();
            renderer.render(scene, camera);
            status.renderFrames += 1;
            if (status.renderFrames === 1) mark('render-first-frame');
            map.triggerRepaint();
          } catch (err) {
            mark('render-fail', err);
          }
        },
      });
      mark('addLayer-ok');
      api.ready = true;
    } catch (err) {
      api.failed = true;
      mark('addLayer-fail', err);
    }
  }

  boot();
  return api;
}
