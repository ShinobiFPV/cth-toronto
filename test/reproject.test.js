// The importer's coordinate handling, checked against ground truth.
//
// The fixtures are real vertices lifted from the City of Toronto's own ward file: the
// MTM pair comes from its EPSG:2952 resource, the WGS84 pair from its EPSG:4326
// resource, same feature, same vertex index. If the inverse projection is right, one
// turns into the other.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCrs, inverseTM, reprojectToWgs84 } from '../scripts/lib/reproject.js';

const MTM10 = { lon0: -79.5, k0: 0.9999, fe: 304800, fn: 0 };

const FIXTURES = [
  { ward: 6, mtm: [305469.014, 4842252.892], wgs84: [-79.4917002, 43.7202374] },
  { ward: 7, mtm: [300731.27, 4844067.493], wgs84: [-79.5505138, 43.7365602] },
  { ward: 11, mtm: [315976.87, 4836691.113], wgs84: [-79.3614033, 43.6700905] },
  { ward: 18, mtm: [309814.049, 4846670.616], wgs84: [-79.437733, 43.7599857] },
  { ward: 19, mtm: [320645.948, 4836063.99], wgs84: [-79.3035226, 43.6643607] },
  { ward: 20, mtm: [326312.457, 4840683.012], wgs84: [-79.2330775, 43.7057952] },
  { ward: 23, mtm: [327131.37, 4850154.108], wgs84: [-79.222523, 43.7910213] },
  { ward: 25, mtm: [334021.956, 4848050.001], wgs84: [-79.1370196, 43.7718424] },
];

const metres = ([lngA, latA], [lngB, latB]) => Math.hypot(
  (latA - latB) * 111320,
  (lngA - lngB) * 111320 * Math.cos((latB * Math.PI) / 180),
);

describe('reprojection', () => {
  test('inverts MTM zone 10 to within a metre of the city\'s own WGS84 file', () => {
    for (const f of FIXTURES) {
      const got = inverseTM(f.mtm[0], f.mtm[1], MTM10);
      const error = metres(got, f.wgs84);
      assert.ok(error < 1, `Hood ${f.ward}: ${error.toFixed(3)} m off`);
    }
  });

  test('recognises an already-WGS84 file from its CRS member', () => {
    assert.equal(detectCrs({
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      features: [],
    }), 'wgs84');
  });

  test('recognises EPSG:2952 from its CRS member', () => {
    assert.equal(detectCrs({
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2952' } },
      features: [],
    }), 'EPSG:2952');
  });

  test('falls back to coordinate magnitude when there is no CRS member', () => {
    const fc = (x, y) => ({
      features: [{ geometry: { type: 'Polygon', coordinates: [[[x, y]]] } }],
    });
    assert.equal(detectCrs(fc(-79.38, 43.65)), 'wgs84');
    assert.equal(detectCrs(fc(310000, 4840000)), 'EPSG:2952');
    assert.equal(detectCrs(fc(620000, 4840000)), 'EPSG:26917');
  });

  test('refuses a projection it cannot invert accurately rather than mangling it', () => {
    // EPSG:2945 is MTM zone 4 — a Quebec zone about 20° off Toronto's meridian, where
    // the transverse Mercator series stops being trustworthy. The city ships it anyway.
    assert.throws(
      () => detectCrs({
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2945' } },
        features: [],
      }),
      /EPSG:2945.*EPSG:4326/s,
    );
  });

  test('reprojects a whole FeatureCollection and keeps its properties', () => {
    const src = {
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2952' } },
      features: FIXTURES.map((f) => ({
        type: 'Feature',
        properties: { AREA_SHORT_CODE: String(f.ward).padStart(2, '0') },
        geometry: { type: 'Polygon', coordinates: [[f.mtm]] },
      })),
    };
    const out = reprojectToWgs84(src, 'EPSG:2952');
    assert.equal(out.features.length, FIXTURES.length);
    out.features.forEach((feature, i) => {
      assert.equal(feature.properties.AREA_SHORT_CODE, String(FIXTURES[i].ward).padStart(2, '0'));
      assert.ok(metres(feature.geometry.coordinates[0][0], FIXTURES[i].wgs84) < 1);
    });
  });
});
