// What a claim is about, as a line in the feed or a Hood's history: the card it printed,
// whatever kind, as a button that opens it — or, for a claim that printed no card, the car
// it spotted, the hunt it finished, or the subject it declared. The server marks every card-printing claim with
// `card`, so this never has to know which kinds of card exist.
import { collectable } from '../lib/collectables.js';
import { Subject } from './bits.jsx';

export default function CardLink({ claim: c, onOpen }) {
  const name = c.park?.name ?? c.vehicle?.name ?? c.hunt?.title;
  if (c.card) {
    const { Icon } = collectable(c.card.kind);
    return (
      <button className="btn btn-sm btn-ghost" onClick={() => onOpen(c.id)} title={`See the ${name} card`}>
        <Icon style={{ width: 14, height: 14 }} />
        {name}
      </button>
    );
  }
  if (name) return <span className="tiny dim">{name}</span>;
  return c.photo_type ? <Subject type={c.photo_type} /> : null;
}
