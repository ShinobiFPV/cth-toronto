// Location never reaches this server.
//
// Find a Park and the dot on the map work entirely on the phone: the browser gets a fix,
// the client already holds every park's coordinates, and the distances are computed there.
// No endpoint takes a position, and this middleware makes sure none ever quietly starts
// to — a request carrying anything that looks like a coordinate is refused before a route
// can see it, let alone log it.
//
// That matters more than it looks in a game where one of the players runs the server.
// "The app knows where I am" and "the admin's Pi has a record of where I was on Tuesday"
// are very different things, and the second is easy to create by accident. If a feature
// ever seems to need a position on the server, that is the moment to stop and ask.
//
// (Photo EXIF is a separate, older matter: it rides inside the image file, not in a
// request field, and is read for the dispute panel. This guards the API's own surface.)

const COORDINATE_KEY = /^(lat|lng|lon|long|latitude|longitude|coords?|coordinates|accuracy|altitude|heading|geolocation|position)$/i;

/** The first key anywhere in a query or body that looks like a coordinate, or null. */
export function findCoordinates(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (COORDINATE_KEY.test(key)) return key;
    const nested = findCoordinates(inner, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function refuseCoordinates(req, res, next) {
  const field = findCoordinates(req.query) ?? findCoordinates(req.body);
  if (field) {
    return res.status(400).json({
      error: 'COORDINATES_REFUSED',
      message: 'This server never takes a location. Find a Park works it out on your phone.',
      field,
    });
  }
  return next();
}
