// Park amenities: which parks have a playground, a ball diamond, a dog off-leash area.
//
// Park hunts are built from these, never from a language model's guess — asked to invent
// items from a park's name, a model will confidently put a splash pad in a parkette that is
// a bench and two trees, and a child gets sent to look for something that is not there.
//
// The data is the city's `parks-and-recreation-facilities` records. Takes a database handle
// rather than importing db.js, because db.js calls it on boot.

/** "Dog Off-Leash Area" → "dog_off_leash_area". */
export const amenitySlug = (name) => String(name ?? '')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The city's comma-separated list, as slugs. "None" is the city saying there are none. */
export const amenitySlugs = (text) => [...new Set(String(text ?? '')
  .split(',').map(amenitySlug).filter((s) => s && s !== 'none'))];

/** Replace park_amenities wholesale from parks.amenities. */
export function rebuildAmenitiesFromParks(db) {
  const parks = db.prepare('SELECT id, amenities FROM parks').all();
  let rows = 0;
  let withAny = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM park_amenities').run();
    const insert = db.prepare('INSERT OR IGNORE INTO park_amenities (park_id, amenity) VALUES (?, ?)');
    for (const park of parks) {
      const slugs = amenitySlugs(park.amenities);
      if (slugs.length) withAny += 1;
      for (const slug of slugs) { insert.run(park.id, slug); rows += 1; }
    }
  })();
  return { parks: withAny, rows };
}
