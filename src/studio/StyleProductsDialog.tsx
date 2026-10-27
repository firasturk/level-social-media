/**
 * The products in a picture made in a style that shows several (27 Oct): the card's own product
 * stays, and the team picks the others from the month's products, grouped by family, with the
 * studio's suggestion ticked first (coffee with coffee, fresh juice with fresh juice). Nothing is
 * written or paid until Continue.
 */
import { useState } from "react";
import { Check, Layers } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import "./client-changes.css";
import "./style-products.css";

export interface StyleProductCard {
  index: number;
  title: string;
  styleTitle: string;
  product: string;
  family: string;
  want: number;
  suggested: string[];
}
export interface StyleProductPool {
  name: string;
  family: string;
  id: string;
}

export default function StyleProductsDialog({ cards, pool, thumb, onConfirm, onClose }: { cards: StyleProductCard[]; pool: StyleProductPool[]; thumb: (id: string) => string; onConfirm: (choice: Record<number, string[]>) => void; onClose: () => void }) {
  const [choice, setChoice] = useState<Record<number, string[]>>(() => Object.fromEntries(cards.map((c) => [c.index, c.suggested])));
  const families = [...new Set(pool.map((p) => p.family))];
  const toggle = (card: StyleProductCard, name: string) => {
    setChoice((c) => {
      const cur = c[card.index] ?? [];
      if (cur.includes(name)) return { ...c, [card.index]: cur.filter((n) => n !== name) };
      if (cur.length >= card.want) return { ...c, [card.index]: [...cur.slice(1), name] };
      return { ...c, [card.index]: [...cur, name] };
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="ccd spd">
        <DialogHeader>
          <DialogTitle>
            <Layers size={16} /> Products in each picture
          </DialogTitle>
          <DialogDescription>These styles show several products. Each card keeps its own product; pick the others from the month. The ticked ones are the studio's suggestion: products of the same family.</DialogDescription>
        </DialogHeader>
        <div className="ccd-list">
          {cards.map((card) => {
            const cur = choice[card.index] ?? [];
            return (
              <div key={card.index} className="ccd-post">
                <div className="ccd-title">
                  <b>
                    {card.index}. {card.title}
                  </b>
                  <small>
                    {card.styleTitle} · shows {card.want + 1} products
                  </small>
                </div>
                <div className="spd-own">
                  <span className="chip on spd-chip">
                    {pool.find((p) => p.name === card.product) && <img src={thumb(pool.find((p) => p.name === card.product)!.id)} alt="" />}
                    <Check size={12} /> {card.product}
                  </span>
                  <small>{card.family} · this card’s own product</small>
                </div>
                <div className="spd-pick">
                  <small>
                    Pick {card.want} more · {cur.length} of {card.want} chosen
                  </small>
                  {families.map((f) => {
                    const items = pool.filter((p) => p.family === f && p.name !== card.product);
                    if (!items.length) return null;
                    return (
                      <div key={f} className="spd-family">
                        <span className={`spd-fam ${f === card.family ? "same" : ""}`}>{f}</span>
                        {items.map((p) => (
                          <button key={p.name} type="button" className={`chip spd-chip ${cur.includes(p.name) ? "on" : ""}`} onClick={() => toggle(card, p.name)} title={cur.includes(p.name) ? "Take it out of this picture" : "Put it in this picture"}>
                            <img src={thumb(p.id)} alt="" loading="lazy" />
                            {cur.includes(p.name) && <Check size={12} />} {p.name}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ccd-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="btn primary" onClick={() => onConfirm(choice)}>
            Continue with these products
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
