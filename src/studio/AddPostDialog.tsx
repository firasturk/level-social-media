/**
 * "Add a post" (27 Oct): a product of the month (its picture, so the team sees what it picks), a
 * style from the gallery, then the studio: the new card shows the product's own photo until its
 * picture is made. Nothing is paid here.
 */
import { useState } from "react";
import { Check, Palette, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { styleThumb } from "./StyleGallery";
import type { StyleItem } from "@shared/styles";
import "./client-changes.css";
import "./style-products.css";

export default function AddPostDialog({ products, style, onPickStyle, onClearStyle, onContinue, onClose }: { products: { id: string; name: string; src: string }[]; style: StyleItem | null; onPickStyle: () => void; onClearStyle: () => void; onContinue: (sourceId: string) => void; onClose: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="ccd spd apd">
        <DialogHeader>
          <DialogTitle>
            <Plus size={16} /> Add a post
          </DialogTitle>
          <DialogDescription>Choose a product of the month and, if you like, a style. The new card shows the product's own photo; its picture is made when you ask.</DialogDescription>
        </DialogHeader>
        <div className="ccd-list">
          <div className="ccd-post">
            <div className="ccd-title">
              <b>1. The product</b>
              <small>{source ? products.find((p) => p.id === source)?.name : "pick one"}</small>
            </div>
            <div className="apd-grid">
              {products.map((p) => (
                <button key={p.id} type="button" className={`apd-product ${source === p.id ? "on" : ""}`} onClick={() => setSource(p.id)} title={p.name}>
                  <img src={p.src} alt="" loading="lazy" />
                  <span>{p.name}</span>
                  {source === p.id && (
                    <i className="apd-tick">
                      <Check size={12} />
                    </i>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="ccd-post">
            <div className="ccd-title">
              <b>2. The style</b>
              <small>optional · a style that shows several products asks which next</small>
            </div>
            <div className="spd-own">
              {style ? (
                <>
                  <span className="chip on spd-chip">
                    <img src={styleThumb(style)} alt="" />
                    <Check size={12} /> {style.title}
                  </span>
                  <button type="button" className="chip" onClick={onPickStyle}>
                    <Palette size={12} /> Change
                  </button>
                  <button type="button" className="icon-button" aria-label="No style" title="No style" onClick={onClearStyle}>
                    <X size={14} />
                  </button>
                </>
              ) : (
                <button type="button" className="chip" onClick={onPickStyle}>
                  <Palette size={12} /> Pick a style
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="ccd-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="btn primary" disabled={!source} onClick={() => source && onContinue(source)}>
            Continue to the studio
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
