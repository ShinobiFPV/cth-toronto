// Read-only EXIF (spec §1.4). The server never acts on any of it — it exists purely
// so a flagger has something concrete to argue about. Absent EXIF is normal, not
// suspicious: plenty of export pipelines strip it.
import { useState } from 'react';

export default function ShotData({ data }) {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  const rows = [
    ['Camera', [data.make, data.model].filter(Boolean).join(' ') || null],
    ['Lens', data.lens],
    ['Taken', data.taken_at ? new Date(data.taken_at).toLocaleString('en-CA') : null],
    ['Exposure', [
      data.aperture && `f/${data.aperture}`,
      data.shutter && `${data.shutter < 1 ? `1/${Math.round(1 / data.shutter)}` : `${data.shutter}s`}`,
      data.iso && `ISO ${data.iso}`,
      data.focal_length && `${Math.round(data.focal_length)}mm`,
    ].filter(Boolean).join(' · ') || null],
    ['Altitude', data.altitude != null ? `${Math.round(data.altitude)} m` : null],
    ['GPS', data.lat != null && data.lng != null
      ? `${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}` : null],
    ['Software', data.software],
  ].filter(([, v]) => v);

  if (!rows.length) return null;

  return (
    <div>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide shot data' : 'Shot data'}
      </button>
      {open && (
        <table className="table" style={{ marginTop: '0.4rem' }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="tiny dim" style={{ width: '6.5rem' }}>{k}</td>
                <td className="tiny">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <p className="tiny dim" style={{ marginTop: '0.4rem' }}>
          Straight off the file. The server ignores every value here — it does not decide
          anything. Missing data is not proof of anything either.
        </p>
      )}
    </div>
  );
}
