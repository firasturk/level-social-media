-- Campaign Autopilot (docs/campaign-autopilot.md): a whole campaign planned, reviewed, approved and
-- produced. One row per campaign plan; one row per production step once a plan is approved.
--   campaign_plans.status: planning | draft | approved | producing | paused | done | failed | discarded
--   campaign_steps.status: waiting (its inputs are not done yet) | ready | running | done | failed
--                        | paused (a material edit or a budget stop: needs the admin) | skipped
CREATE TABLE IF NOT EXISTS campaign_plans (
  id TEXT PRIMARY KEY,
  batch TEXT NOT NULL,                  -- the month the cards go into
  client TEXT,
  owner TEXT NOT NULL,                  -- the admin who made it
  status TEXT NOT NULL DEFAULT 'draft',
  setup TEXT NOT NULL,                  -- CampaignSetup JSON
  plan TEXT NOT NULL,                   -- CampaignPlan JSON (rev inside)
  rev INTEGER NOT NULL DEFAULT 1,
  prices TEXT NOT NULL DEFAULT '{}',    -- PriceBook JSON, as last learned
  prices_at INTEGER,
  approval TEXT,                        -- ApprovalTerms JSON + signature, of the approval in force
  approved_sig TEXT,
  approved_at INTEGER,
  approved_by TEXT,
  pause_reason TEXT,
  simulate INTEGER NOT NULL DEFAULT 0,  -- 1: no provider is called (the preview); every result is labelled simulated
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS campaign_plans_batch ON campaign_plans(batch, created);
CREATE INDEX IF NOT EXISTS campaign_plans_status ON campaign_plans(status, updated);

CREATE TABLE IF NOT EXISTS campaign_steps (
  campaign TEXT NOT NULL,
  step TEXT NOT NULL,                   -- StepSpec.id: <item>:<shot or ->:<kind>
  item TEXT NOT NULL,
  shot TEXT,
  kind TEXT NOT NULL,                   -- post | image | frame | clip | assemble | render
  deps TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',
  unit TEXT,                            -- usd | higgsfield-credits | magnific-credits (paid steps)
  price_key TEXT,
  estimate REAL,                        -- what one attempt is expected to cost
  reserved REAL NOT NULL DEFAULT 0,     -- held in the campaign's ledger scope for the running attempt
  spent REAL NOT NULL DEFAULT 0,        -- what the finished attempts cost (reported, else the estimate)
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  sig TEXT,                             -- the step's signature (stepSignature) the approval covers
  run_sig TEXT,                         -- the signature the running or finished attempt was made for
  post INTEGER,                         -- the card (post index) this step works on
  ref_kind TEXT,                        -- task | photo_job | video | project | render
  ref_id TEXT,
  output_key TEXT,                      -- a picture or clip this step produced (R2)
  note TEXT,
  data TEXT,                            -- kind-specific JSON (a render step: the photo shots the browser draws as clips)
  error TEXT,
  started INTEGER,
  finished INTEGER,
  updated INTEGER NOT NULL,
  PRIMARY KEY (campaign, step)
);
CREATE INDEX IF NOT EXISTS campaign_steps_status ON campaign_steps(campaign, status);
