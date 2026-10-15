# Level Social Media skill

A Claude skill for building Level Social Media, Level MENA's social-media post studio, as a
re-branded clone of Max Fashion Studio.

## Install in the new project

```sh
mkdir -p .claude/skills
cp -r docs/level-social-media .claude/skills/level-social-media
```

Then in the new project say: "use the level-social-media skill, start phase 0".

## Contents

| File                          | What                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SKILL.md`                    | The skill: product in one screen, what to reuse, what changes, how to work with Firas                   |
| `references/SOURCE_SYSTEM.md` | Map of Max Fashion Studio: runtime, engines, modules, tables, strings to rename                         |
| `references/PRODUCT_SPEC.md`  | Clients, brand kits, themes, rules, post types, scripts, formats, grid sets, overlay, captions, screens |
| `references/DATA_MODEL.md`    | Migrations 0016–0018, scope keys, config fields, API routes, engine changes, export naming              |
| `references/PROMPTS.md`       | Prompt composition, new rule constants, split/grid/caption instructions, revision presets               |
| `references/BUILD_PLAN.md`    | Phases 0–8 with acceptance checks and the per-session checklist                                         |

## بالعربي

هذا الملف هو "السكيل" الذي تفتح به المشروع الجديد. انسخ المجلد إلى `.claude/skills/level-social-media`
داخل المشروع الجديد، ثم اطلب من كلود: "استخدم سكيل level-social-media وابدأ المرحلة صفر".
السكيل يشرح كيف نأخذ نظام Max Fashion Studio كما هو (المحركات، المكتبات، القواعد، التصدير)
ونغيّر الواجهة: بدل الـ approaches تصير بطاقات **عملاء**، لكل عميل هوية بصرية (شعار، ألوان، خطوط،
نبرة، صور مرجعية، شبكة الفيد)، و**ثيمات**، وقواعد ثابتة خاصة به. المدخل إما **منتجات** أو **سكريبت**،
والمخرج بوستات بمقاسات 1:1 و4:5 و9:16، أو **شبكة فيد** كاملة، أو كاروسيل، مع الكابشن وملف ZIP لكل عميل.
