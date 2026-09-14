// Any card, whatever kind. The face — ParkCard, NotWheelsCard, whatever comes next — comes
// from the registry in lib/collectables.js, so nothing that shows a card has to ask which
// kind it is.
import { collectable } from '../lib/collectables.js';

export default function Card({ card, ...rest }) {
  if (!card) return null;
  const { Face } = collectable(card.kind);
  return <Face card={card} {...rest} />;
}
