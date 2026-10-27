/** The studio's how-to guide the Help assistant answers from (server/help.ts). Keep it true to the UI: update it with every change to a label or flow. */
export const HELP_GUIDE = `
# Level Studio: how-to guide

Level Studio is Level MENA's social-media post studio. For each client it plans a month of Instagram posts, makes the pictures with AI (or takes the client's own pictures and clips), puts the words and logo on them, makes videos, sends the month to the client for approval, delivers it to the client's Drive and publishes to Instagram. The screens are in English; labels below are written exactly as they appear.

Golden rules: nothing that costs money or credits runs without a confirmation saying what it touches and what it costs. Earlier pictures are never thrown away: they stay under Versions.

## 1. Words used in the studio

- Month: one client's month of posts. A month can hold several grids (separate sets of posts, each with its own client link).
- Post: one item of the feed (a carousel counts as one post). Design: every slide or tile (a 4-slide carousel is 1 post, 4 designs).
- Carousel: slides posted together as one Instagram post (2 to 10). Cards show "Carousel 2/4". Series: posts that belong together but go out separately ("Series 1/3"). Separator: a calm post between the others.
- Text tile: a tile of only words and colour (from a grid), drawn in the studio for free.
- Take / version: every picture made for a post is kept; the current one is on the card.
- Brand kit: the client's colours, fonts, logo, tone, language, rules. Theme: the month's look (photos and pins). Style: a look from the Styles library. Grid: a picture of a whole feed a month can follow tile by tile.
- Product photo: a real photo of the product; it always wins. Reference picture: a picture pinned to one post to take a background, light or mood from.
- Models (ambassadors): AI people with the same face in every post.
- Credits: Higgsfield subscription credits or the Magnific balance (AI tools, presets, video). Pictures from the image engine are priced in dollars.

## 2. The main screens

Left menu (a rail of icons until opened with its top button "Open the menu"): "Approvals" (admins), "Studio", "Months", "Styles", "Video editor", "Admin" (admins), then "Clients" (click one to open it; "+" = "Add client"), and at the bottom the connection button ("Connected" / "Not connected" with the engine's name; opens "Image engine connection"), the light/dark switch and "Sign out".

The four-stage workflow (an admin setting, "Four-stage workflow", for the whole team): "1 Start", "2 Direction", "3 Plan", "4 Studio". Start, Direction and Plan open full screen under the title "Create content"; their top bar has the menu button, the stages, the client and month pickers, the brand kit chip ("Brand kit ready" or "N things missing") and "Skip to the Studio". The Studio is the board of posts; its top rail repeats the stages and has "Classic journey".

Classic journey: the older step-by-step screens (Account, Products, Posts, Brand kit, Visual identity, Colours, Ideas and dates, Props and shots, Test grid, Generate, Text on design, Feed). Open it with "Classic journey" (Studio rail, or More "⋯"). If the four-stage workflow is off, the Studio shows "Start new journey" and "Open the journey". The client's Instagram/website "Analysis" (client profile) is on its first screen.

Months page: every month you can open, with progress; filter by client. A deleted month waits in the "Bin" for 30 days ("Restore", or "Delete for good"). Admins also see "Spend by person".

## 3. Admins and members

- Members see only the months they created; admins see all months.
- Members can: plan, write and edit ideas and words, make pictures with the image engine (cost confirmed), "Edit this picture" with AI, Adjust, the Text studio, Versions, checks, browse presets and styles, use the client's Drive photos, send the client link, export, deliver to Drive, publish to Instagram (once an admin connected it), add clients.
- Admins only for now: Connection settings, the Admin and Approvals pages, the Photo studio's "AI tools" and running "Presets", the "Photo lab", Freepik stock ("Add from Freepik", Stock assets), adding an AI tools result as posts or a carousel, making/enhancing/checking videos, saving and rendering in the video editor, uploading clips, "Combine into one video", choosing which video the client sees, archiving clients and renaming / re-ordering / changing the logo of clients.
- Admins-only controls say "Admins only for now". A member should ask an admin (Firas).
- If an admin set "Who sees prices" to admins only, members see "cost shown to admins"; the confirmations still appear.

## 4. Starting a month (Start)

1. Pick the client in the left menu. The studio opens on the current calendar month; change it with the month picker on "Create content" (or open a month from Months).
2. In the Studio click "1 Start" (or "Create content" on an empty month). Choose one of four cards:
- "Quick Campaign" ("Turn a brief into a campaign, typed or spoken."), button "Write a brief".
- "Follow a grid" ("Plan a campaign from a grid, one post per tile."), button "Pick a grid".
- "Edit images" ("Choose one or more images. Edit, style and add text."), "Direct to Studio": "Choose from Drive" / "Upload files".
- "Create or edit video" ("Choose images or clips. Create and edit your video."), "Direct to Studio": "Choose from Drive" / "Upload files".
The first two go through Direction and Plan; the direct ones go straight to the Studio. If the month is already planned, "Saved plan" shows it with "Open the plan"; what you start adds to it or replaces it only when you say so.

### Quick Campaign
1. "Write a brief": type (or "Dictate") what the posts show, how many, carousels, colours, any text.
2. Optional "Attach reference pictures" (up to 12; each is recreated on its post).
3. If the month has posts: "Create new posts" (current posts stay) or "Replace the month's posts" (current plan kept under Versions).
4. "Plan it" writes a draft (a text call); nothing changes yet. Read "Draft · not applied" (new posts, posts that would change, pictures that would belong to an older idea), then click its apply button (e.g. "Add 6 posts", "Replace the month's 12 posts with 15 designs") or "Discard the draft". "Plan it again" rewrites it.
5. "What was understood" lets you edit each post's title and scene. Then "Continue to Direction".

### Follow a grid
"Pick a grid" from the library. The preview shows its real post count and what each tile is ("Change grid" to pick another). If the counts differ choose "Use the grid's N posts" or "Adapt to my N posts". "Continue to Direction" asks "Follow this grid": the month is planned tile by tile (existing posts are planned again; the old plan stays under Versions; pictures stay until remade). Product photos are matched to tiles from the client's Drive.

### Edit images / Create or edit video
1. "Choose from Drive" or "Upload files" (both can be combined). The dialog has the "Client's Drive" tab (approved folders, by role, searchable) and this computer; picks go into one numbered tray (x removes).
2. Pictures: PNG, JPEG or WebP up to 20 MB. Clips (MP4 up to 60 MB) are admins only; "Edit images" cannot take clips.
3. "Create N and open the Studio": one card per file after the month's posts. Nothing is generated or paid. The new cards arrive already chosen for the next step (section 8: style, Text studio, combine into a video).

### Also on Start
- "Product photos" with "upload".
- "Campaign size" ("Edit size" / "Change the size"): "Posts", "Carousels", "Slides per carousel" (2 to 10), "Separators", "Designs per separator", "Format" (Square post 1:1, Portrait post 4:5, Story / Reel cover 9:16), "Save size". On a month with posts, a higher count offers "Save and add N posts". The size is sent to the planner when you "Plan it" for the whole month.
- "Shortcuts": "Continue from <previous month>" (same theme, colours, props, models and products), "Open <month> in the Studio", "Fresh grid in <month>" (a new separate grid; also More → "New grid in this month").

## 5. Direction

"What will shape the pictures". Nothing here spends the picture budget.
- "Leads this month" with "Start another way" / "Edit the brief" / "Change the grid".
- "Supporting inputs": pictures pinned to posts ("Pin on the plan" / "Manage"; "Add from Freepik", admins), "Theme references" ("Add" / "Manage"; "Analyse the pins" reads them into shots and a palette, a text and vision call), "Grid" ("Add a grid" / "Change"), "Product images" (section 6), "Models" ("Choose models" / "Change models" / "Add a model": tick "In this month" on up to 3, "Done").
- "When inputs meet on one post, this wins": 1 Product photo › 2 Picture pinned to the post › 3 Applied style › 4 Grid tile › 5 Theme reference. Brand rules and the month's colours apply on top.
- "Rules that apply this month" with "Open the brand memory".
- "Colours": "Client's brand colours", "The followed grid's colours", "Both" or "Set by you"; "Edit colours" → "Save colours" / "Keep as they are". The first colour is every post's background; a month's colours never change the theme.
- "Format and engine": size, engine, about how much per picture, occasions.
- "Write the plan" (first time) or "Open the plan".

## 6. Product photos and the client's Drive

- On Direction and the Plan ("Product images"): "Choose for me from Drive" proposes a product image per post; review ("Replace", "Exclude"/"Include", "Lock"), then "Use these N product images" (no picture is made). "Choose from Drive" lets you pick yourself. "Upload images" from this computer (also More → "Upload product photos").
- A post whose product has no photo is blocked on the Plan: "Choose a product image".
- Connect a Drive folder: in the Drive picker click "Folders", paste the folder link, choose what it holds ("Product photos", "Brand assets", "References", "Outputs"), then "Approve". First share the folder in Google Drive with the studio's Google account shown in the picker, as Viewer ("Outputs" needs Editor). "Not connected · demo listing" means Google Cloud is not connected (admins, Connection).
- Pin a Drive photo as one post's reference: post editor → "Idea" → "Reference from the client's Drive" → "Pin to post N", or Photo studio → "Assets" → "Client's Drive".

## 7. The Plan ("The plan, before anything is made")

Summary cells: Objective, Product images, Visual direction, Models ("Change"), Reference pictures, Output, and "Needs your attention · N" (blocked posts and why, "Write the shots" for posts without a shot).

Tools:
- "Talk to the planner" (below).
- "Read the scenes before paying": the art director reads each ready post before you pay (text/vision calls, no picture). Notes appear under "Read before paying" in the post's details; "Keep my reference attached anyway" when a reference would be dropped.
- "Write the ideas again": rewrites every idea (asks first). Old posts and pictures stay under Versions; made pictures become "older idea" and are not remade until you ask.
- "Add posts": "How many posts to add?" (1 to 12); new ideas are written, the rest untouched.
- "Read again": refreshes the states and estimate.

Post rows: number, picture, title and "Shot · …"/"Idea · …", product, a state ("Ready to make", "Drawn here", "Making", "Made", "Older idea", "Blocked"), the kind ("Picture", "Carousel · slide 2 of 4", "Text tile · drawn here, free"), the posting date (changing it moves the post), model chips ("+ model"), and "Details" (edit Idea, Shot, headline and caption; conflicts with "Allow on this post" / "Take the style off" / "Withdraw"; "What will guide this picture").

"Test grid": "Make the test grid" paints the whole feed as one picture before you pay for the posts (one paid picture); "Make it again" repaints it.

Making the pictures (the paid step), in the footer:
- "Save the plan, make nothing" (all edits are already saved).
- "Make one test picture · about $X" (one post only).
- "Make all N pictures · about $X" / "Make N pictures · about $X": confirm with "Make N · about $X". Blocked posts are left out; made pictures stay; older-idea posts get a new version.
- Checkbox "If the review finds a problem, retake the picture once by itself" (raises the maximum; untick for no automatic retakes).
- Above the admin's spending limit a second approval appears: "Approve and generate · up to $X".
- Older pictures: "Make it again · about $X" / "Make those N again · about $X".
- In the Studio, "Make N remaining · about $X" (or "Open the plan") opens this Plan.
- When pictures arrive the studio chimes; each picture is reviewed automatically.

### Talk to the planner / Prompt
On the Plan "Talk to the planner"; on the Studio board the "Prompt" button ("Prompt box"). Write or dictate like to a colleague: "Post 3 on the kiwi mojito instead, same idea", "Move the Christmas post to the 24th and make it a greeting", "All the captions in Jordanian Arabic, playful", "Add a Mother's Day post", "Remove post 5", "Crop all the photos to 4:5" (or "make post 2 square", "story size"). Enter sends; Shift+Enter is a new line. A size change is free: the planner knows each picture's size, cuts the middle of the picture to the new frame (the old picture stays under Versions), and says which posts were already in that frame. It never makes new pictures to change a size; to add picture around the edges instead of cutting, use Edit picture → AI tools → Expand or Outpaint (admins, credits).
- It changes a post's title, idea, shot, headline, second line, caption, hashtags, date, product and type; adds and removes posts; sets standing rules for the words.
- Making pictures asks "Generate now" (paid) or "Keep the changes, generate later".
- Tool requests ("Find a minimal background from Freepik for post 3", "Animate this post using Kling through Higgsfield", "Remove the background of post 2") become a card to confirm; running tool cards is admins only.
- It cannot make carousels (section 9).

## 8. The Studio board

Header: tabs "Posts", "Feed", "Words", "Client approval", "Versions"; the counts ("12 posts · 16 designs · 6 made · 2 need a look · 9 remaining"); "Client answered · N new"; buttons "Do client comments (N)" (when the client asked changes), "Export", "Client link", "Make N remaining · about $X" / "Open the plan", "Prompt", "⋯" (More).

More (⋯): "Month tools (upload, ideas, grid, overlay, typography, PDF)", "Send the client link on WhatsApp", "Feed PDF", "Deliver to the client's Drive…", "Schedule the approved posts…", "Upload product photos", "Products, versions and brand kit" (the side panel), "New grid in this month", "Classic journey", "Delete this month" (goes to the Bin).

Month tools bar: "Month", "Grid" (several grids), "New grid", "Posts", "Upload products", "Generate ideas"/"Regenerate ideas", "From reference grid", "Generate N posts"/"Regenerate all" (these make pictures: paid), "Overlay" (show/hide words on cards), "Export", typography ("AI picks for each post", "Behind the product", "Crossing the product", "Repeated", "Big outline"…: a paid AI reading), "Feed PDF".

Tabs:
- "Feed": meant to show the month as a feed; in the four-stage workflow it may open the workflow screens instead. Reliable: More → "Classic journey" → its last screen "Feed", More → "Feed PDF", or the client link.
- "Words": each post's "On the picture" (headline), "Caption", "Hashtags"; saves when you leave a field; free.
- "Client approval": section 12. "Versions": section 16.

### A post card
Top of the picture: number, post type ("Product", "Lifestyle", "Offer", "Tip", "Quote", "Announcement", "Behind the scenes", "Testimonial", "Occasion greeting"; none on the client's own pictures), the format chip "Post" (single picture) or "Carousel 2/4" / "Series 1/3", the posting day, the state, and icons (aperture = Photo studio, T = Text studio, clapperboard = Video studio).
States: "Idea" (no picture), "Queued", "Generating…", "Paused", "Made", "Ready" (client's own picture), "Accepted by the team · <name>", "Older idea", "Failed", "Needs review".
- "Needs review": the automatic review found something (named on the card): "Edit this picture" (AI fix, one paid picture) or "Accept" (free).
- "Older idea": the idea, product or direction changed after the picture was made: "Make it again · about $X" (new version; old one kept) or edit it.
- "Failed · <reason>": "Try again · about $X".
- "Wider than 4:5 · Crop": crop it free in the Photo studio's Adjust.
- A clip on the card shows "the client sees this" or "not the client's version".
Under the picture: title, the client's answer ("Client approved · <name>" / "Client asks a change · <name>"), product, "Style: <name>".
Buttons: "Make the picture · about $X" (no picture yet; asks first, only this post), "Edit picture" (Photo studio) or "Edit the idea" (no picture), "Words & caption" (post editor, free), "Restyle · about $X" (client's own picture with a saved style), and "⋯":
- planned post: "Make another version" (paid), "Write a new idea" (a new idea, then the picture is made again at once: paid), "Pick a style" / "Change the style" / "Take the style off", "Enhance (higher quality)" (paid AI edit), "Open the Text studio", "Animate the text", "Video from this picture", "Publish to Instagram…", "Previous picture", "Reference picture and versions", "Remove this post".
- client's own picture: "Pick a style" / "Take the style off", "Open the Text studio", "Video from this picture", "Publish to Instagram…", "Previous picture", "Versions", "Remove this post".
"Remove this post" acts at once (its picture is kept with the month's earlier versions). A carousel is one card that slides (arrows, dots, "+" after the dots; chip "Carousel 2/3"): every slide is a post of its own and the card's buttons act on the slide shown. "+" or "Add a slide" (menu) adds a copy of slide 1, picture and words, as the next slide (ten at most, nothing paid); "Make it a carousel" on a single post makes it slide 1 and adds slide 2 as its copy; "Remove this slide" removes one. On the client's link a carousel is one post that swipes: "Approve the carousel" approves every slide, a change is asked on the slide on screen. "Unsaved edits kept: …" on a card offers "Open to finish" or "Discard". Clicking the picture opens the post editor ("Idea", "Image", "Words & design", "Versions").

### Choosing several cards
"Choose cards", tick cards (numbered in order). Bar: "Apply a style to N chosen" (saves the style; nothing paid; then "Restyle" each card, confirmed), "Open in Text studio (1 of N)", "Combine into one video" (admins, 2+ cards), "Clear", x to stop.

## 9. Carousels

A carousel is a group of posts with slide numbers; it publishes as one Instagram post (2 to 10 slides, each needs a picture). Ways to make one:
1. Brief: write it ("a carousel of 5 slides that reveals the new cup") or set "Carousels" and "Slides per carousel" in "Campaign size", then "Plan it" and apply the draft.
2. Grid: carousels in the grid's reading are planned as carousels.
3. From an existing post with the Photo studio's AI tools (admins): card → "Edit picture" → "AI tools" → pick a tool (e.g. "Variations", "Restyle", "Reimagine", "Change camera") → "Run …" and confirm the credits → under the result click "Add as a carousel". The post becomes slide 1 and the result the next slide(s); this step is free. "Variations" adds its nine pictures (10 slides, the maximum); other tools add one, so run more tools to add more slides. A carousel holds at most 10; a series post cannot become a carousel. The alternative is "Add as a new post" ("Add each picture as a new post" for Variations): new single posts after the month's posts, copying the idea and words.
Each slide is its own card with its own picture, words and versions.

## 10. The Photo studio

Open it from a card's "Edit picture" or aperture icon, "Open the Photo studio" in the post editor, or "Photo studio" in the Text/Video studio. It needs a picture.
Top bar: post and title, state, "Adjustments not applied", the client-hold note, undo/redo, "Versions · N", "Text studio", "Video studio", "Save & return", x (asks "Save & return" or "Keep for later"). Keys: [ ] previous/next post, Z fit/100%, hold C for the product photo, Esc.
Rail: "Presets", "AI tools", "Edit", "Adjust", "Photo lab", "Assets", "Versions", "Check" (a lock marks admins-only tools; on a phone Presets and AI tools share "AI").

- "Edit" (Edit with AI): views "Compare", "AI result", "Original"; instruction box with "Dictate the change"; "Mark an area" (guides the instruction, not a mask); "Quick instructions" ("Background", "Lighting", "Composition", "Remove an object", "Product correction", "Blend with scene", "More brand colour", "Cleaner background", "Leave headline space", "Match product", "Remove text", "Brighter", "Closer"); "Attach a reference for this edit" ("Change" / "Take off"); "Edit this picture · about $X" (one paid picture, confirmed; old picture under Versions); "Or start over": "Make another version · about $X". Open to anyone on the month.
- "Adjust" ("Free · drawn here"): "Crop" (Free, 1:1, 4:5, 9:16), turn, flip, "Straighten", "Exposure", "Contrast", "Saturation", "Temperature", "Tint", "Highlights", "Shadows", "Sharpen", "Vignette"; "Hold for before", "Reset"; "Apply as the post's picture" (free).
- "Presets": gallery with sample pictures: "Styles", "Product shots", "Magnific looks", "Recipes"; "Search presets". Browsing is free for everyone. A card shows "Needs:", "Cost:", "Ready?", "Learn more". "Use this style" / "Use this look" / "Use these words" fill AI tools. Product shots: "Use this preset", then under "Run it here" an admin checks "The product (sent first, so the engine keeps it)" (pre-filled; correct it), fills any fields, "Run this preset · N credits" (or "· cost not known") and confirms. The product picture sent is the post's clean product photo (its name is shown, "Product picture: …"), so the preset's own scene, people and background are used; tick the box to send the post's whole picture instead (its scene may come along). The words box takes only what to change (e.g. "a man instead of a woman"). The post needs a picture first. The result appears in AI tools, where "Add as a new post" and "Add as a carousel" keep the original post as it is.
- "AI tools" (admins only; credits): tabs "Higgsfield" ("Upscale", "Remove background", "Outpaint", "Relight", "Generate with a style") and "Magnific" ("Upscale", "Relight", "Remove background", "Replace background", "Retouch", "Skin enhancer", "Expand", "Restyle", "Reimagine", "Change camera", "Variations" = nine variations). Steps: pick a tool, fill options ("Needed first: …"), "Get the cost" ("About N credits · balance M" or "Cost not known"; nothing is made), "Run <tool> · N credits", confirm ("Run · N credits"; Higgsfield unknown cost: "Run it anyway, cost unknown"; Magnific unknown cost is blocked). A tool marked "not listed" is refused before anything is sent. The result shows before/after on the canvas; then "Use as the post's picture", "Save as a product photo", "Download", "Add as a new post" / "Add each picture as a new post", "Add as a carousel" (after adding: "Added as post N"). Variations has no "Use as the post's picture". A failed run: "Check again" (free status read; collects the picture if the provider finished). "Earlier results (N)" lists past runs.
- "Photo lab" (admins only; Freepik, dollars): "Remove background", "Replace background", "Relight", "Upscale" on "This post's picture" or "Client's Drive photos"; "Run … · about $X", then "Use as the post's picture", "Save as a product photo", "Download". "Demo · not connected" = no Freepik key.
- "Assets": "Stock" (Freepik, admins: "Add as layer", "Set as background", "Use as reference", "Save to library"; layers open the Text studio, free) and "Client's Drive" (pin a photo as the reference for the next AI edit).
- "Versions": every take ("Current picture" / "Earlier take" / "Failed", date, cost, note): "Compare", "Edit this version", "Use this picture", "Previous picture", video versions, "The month's earlier versions".
- "Check": "Automatic review" ("Edit this picture" paid / "Accept as it is" free) and "Writing check (OCR)": "Check the raw picture", "Check the final artwork" (a Vision reading; demo when not connected).

## 11. Words, captions and languages

- Headline, second line and logo are layers drawn over the picture: changing them is free and never remakes it. Letters the engine drew inside the photo are part of the picture: "Edit this picture" with "Remove text" removes them (paid).
- Change text: the "Words" tab, the card's "Words & caption", or the post editor's "Words & design": "Headline: drawn on the picture", "Second line", "Text on the image" (untick for a text-free picture), "Dark fade behind the words", "Caption: posted with the picture, not drawn on it", "Dictate the caption", "Write the caption from the picture" (a text call), "Hashtags", "Language for this post", "Save", "Open the Text studio", "Animate", "Video".
- "Check the words": the art director checks the post as published; "Apply its moves by itself", or "Apply the moves" / "Leave the words as they are".
- Captions are written automatically from the picture when it is made or remade, unless you wrote the caption. The client's own pictures are not: use "Write the caption from the picture".
- Languages: brand kit "Content language" ("Arabic", "English", "Arabic and English (bilingual layouts)") is the default; one post can differ ("Language for this post"). Nothing is translated automatically; the Text studio Assistant has "Translate…", and the planner can rewrite captions in another language.

### Text studio (free)
Open with the card's T icon, "Open the Text studio", or from the Photo/Video studio. Needs a picture and "Text on the image" on.
- Top bar: save state ("Saved", "Saving…", "Unsaved changes"; on a post the client answered: "Draft: not on the client's link yet"), undo/redo, "Apply this style to all posts", "Preview", "Photo studio", "Video studio", "Export" ("JPG · high quality", "Text only · transparent PNG", "PDF", "Back to the automatic layout"), "Save & return".
- Left: "Layers" ("Add": "Text" (T), "Logo", "Image…", "Rectangle", "Ellipse", "Line", product photos, brand assets), "Layouts" ("Preview", "Apply", "All designs…"), "Styles" (the look of one layer), "Brand" (brand fonts and colours, upload a font).
- Right: "Properties", "Assistant" ("Rewrite", "Shorten", "Expand", "Headline ideas", "Call-to-action ideas", "Fix spelling", "Translate…", "Brand tone", "Judge the layout"; suggestions only), "Assets" (Freepik, admins).
- Toolbar: size, weight, bold/italic/underline, alignment, direction "Auto"/"RTL"/"LTR", spacing, opacity; safe zones; shortcuts (?). SVG layers: "Split into layers", "Remove background", "Merge back".
- "Animate the text" (card menu): a short video of the words moving over the picture, exported from the browser; free.

## 12. Client approval

- Send: "Client link" (Studio header) or "Copy the client link" (Client approval tab), or WhatsApp: More → "Send the client link on WhatsApp" / "Send on WhatsApp". One link per month (per grid); it stays the same and needs no sign-in.
- The client's page: "<Client> · <Month>", their name once ("Reviewing as …"), "The feed" (the month as an Instagram profile grid), each post with its picture (words and logo) or video, caption, hashtags, "Version currently shown", "Approve" and "Ask for a change" (reasons "Change the words", "Change the picture", "The colours", "The product looks wrong", "Another date", a note, "Send"). "Being prepared" = no picture yet. "Everything is approved. Thank you!" at the end.
- Reading answers: the "Client approval" tab ("N approved · N to change · N not seen yet"; per post "Client approved", "Change asked", "Not seen yet", "No picture yet", who, note, "Open the post"), the header badge "Client answered · N new", and the card chips.
- "Do client comments (N)": reads the client's change requests and first shows "What the client's comments will change" (each post: the client's words; "The plan": the studio's tools in order, each marked "On Apply" (free), "Asked after Apply" (a new picture, about $0.13) or "You run it" (with where it is, e.g. "Edit picture → AI tools → Magnific Variations → Add as a carousel", and its cost); then the product, headline, caption and shot before → after); nothing is saved until "Apply the changes". A carousel is made with Change camera (other angles), Variations (close variations of the same shot) or Generate (new slides from words), each ending with "Add as a carousel"; Restyle keeps one picture in another look and makes no slides. Applying writes them into the posts, keeps the comments on the cards marked done with the steps still to do (and under Client approval), asks the client again on the link, then asks "Generate now" (paid) or "Keep the changes, generate later" only for the posts whose plan makes the picture again.
- "Client feedback · the month" (bottom of the tab; "Client feedback on this post" in the post editor's Idea): paste or dictate feedback from elsewhere, "Read the feedback"; each change is checked ("Approve", "Reject", "Apply"). Word and layer changes are free; picture edits are paid and confirmed.
- E-mail: switch on "Email me when <client> answers" (Client approval tab). One e-mail per month, about ten minutes after the first answer; with no subscriber every admin gets it. Needs the Notifications key (admins).

### The client hold
When the client answered a post (approved it or asked a change), the link keeps the client's version. Edits to that post (Adjust, an AI result used as the picture, new words, a new video render) are saved as a new version and do not replace it. Editors show "Client approved: saving makes a new version". The card then offers "Send it for review" (the new version becomes the client's and their earlier answer is cleared so they answer again) or "Keep the client's". The Text studio's "Save & return" asks "Save and send for review" or "Keep as a draft"; "Use this picture" / "Previous picture" ask "Use it and send for review" or "Keep the client's". Posts the client has not answered change on the link at once.

## 13. Video

### Video studio
Open with the card's clapperboard, the card menu "Video from this picture", or "Video studio" in the Photo/Text studio. Rail: "Presets", "Generate", "Edit", "Enhance", "Audio", "Versions", "Check".
- "Presets": Higgsfield presets with reference videos ("Popular", "Paid Ads", "Motion Design", "Marketing", "Production", "Faceless", "Effects", "Genjutsu", "Recipes"); browsing free; "Use this preset" fills Generate; "Run this preset · N credits" admins.
- "Generate" (admins): a clip from the post's picture: the motion idea (write, generate from the picture or dictate), "Higgsfield" or "Magnific", engine, length, frame (Reel 9:16 default; Portrait 4:5, Square 1:1, Landscape 16:9), "Include the words and logo in the video input", "Get the cost", "Make the video · N credits".
- "Enhance" (admins): Magnific "Upscale", "Colour grade", "Music", "Sound effects", "Relight", "HDR"; Higgsfield "Upscale", "Reframe", "Remove the background". Cost asked first; the result is a new version.
- "Audio": each version's sound (admins change). "Check" (admins): "Virality check", "Video analysis".
- "Versions": "Show"/"Compare", "Select for client review" (admins), "The client sees this", "Show the picture instead", "Edit", download, "Check again" on a failed clip. The first finished clip becomes the client's version by itself if the client has not answered the post.

### Video editor
"Edit" in the Video studio, or the left menu "Video editor" alone (footage from this computer, saved as a file). Tabs "Media", "Text", "Logo", "Music", "Colour", "Auto edit", "Render". It runs in the browser; nothing is paid. Saving and rendering are admins only for now.
- "Media": templates ("Use the template"), footage (add to timeline; MP4/MOV up to 60 MB), trim, speed, sound, joins. "Text": words over the video. "Logo": logo or picture, "From the asset library".
- "Music": "Browse the music library" ("Catalog", "<Client> tracks", moods, genre, length, tempo, "Use in this video"; licence and credit per track) or a track from the computer; "Align cuts to beats"; "Voice-over".
- "Colour": presets, corrections, LUT, "Match colour to a reference".
- "Auto edit": "Purpose" ("Product launch", "Promo", "Story"), "Length", pace ("Calm", "Balanced", "Energetic"), words on hook and end card, "Build the cut" (undo brings the old cut back). "Edit like this video": give a video, Pinterest pin or clip; your footage is cut the same way.
- "Render": frame, quality, "Render & update card" ("Render to a file" when standalone). Keep the tab open until it finishes. "Save draft" keeps the project. If the client answered the version they see: "Send for review (make it the client's version)". The software licences page is /licences ("Open-source licences").

### Combine cards into one video (admins)
"Choose cards" → tick 2+ → "Combine into one video" → order them, "Save the project on" ("A new card" or a post) → "Combine N and open the editor". Pictures join as 3-second clips. Nothing generated or paid.

## 14. Clients and the brand kit

- Add a client: left menu "+" ("Add client"). Admins also "Rename client", "Change logo", "Move up"/"Move down", "Archive client"/"Restore client".
- Brand kit: the Studio side panel (More → "Products, versions and brand kit", the "Products · versions · brand kit" rail, or the brand kit chip). The panel also holds the month's "Products", "Notes and grid" and "Earlier versions". Sections:
  - "Brand kit": logos, "Place photos", "Real people", "Brand colours", "Headline font"/"Body font", "Tone of voice and language" ("Content language"), "Rules", "Past posts (identity)".
  - "Brand ambassadors": add by name, describe the look, "Generate portrait" (one paid picture) or "Upload"; tick "In this month" (up to 3).
  - "Theme": "Theme of the month" ("No theme (brand identity only)"), "New theme", "Delete", "Photos and pins" ("Add photos"), "Visual language", "Colours this month", props, wardrobe, "Shots from the references".
  - "Overlay": how headline, second line and logo are drawn (layout, fonts, logo, corner, spacing).
  - "Brand memory": rules, this month's instructions, lessons waiting for approval.
  - "Output": "Image engine", "Post size", "Resolution", "Posts per month", "Exact product: place the real photo, never redraw it".

## 15. Styles library

Left menu "Styles": tabs like "All", "Trends", "Grids" and categories. "Add" (Pinterest links; "Feed grids" for whole feeds) or upload pictures; a member's additions wait for an admin ("Approvals": "Grids to approve", "Styles to approve", "Lessons learned"). Selected styles can be added to a client ("Add to a client's…"), written again, or replaced. A style picked for a post ("Pick a style") rewrites its idea and shot for that post's product; making the picture is a separate confirmed step.

## 16. Versions, undo, restoring

- Post editor "Versions" or Photo studio "Versions": "Compare", "Use this picture". "Previous picture" brings back the picture from before the last remake.
- Studio "Versions" tab / side panel "Earlier versions": whole earlier plans; "Use this version in the studio" (the current month is kept as a version) or "Use for post N".
- Undo/redo exist in the Photo studio (adjustments), Text studio and video editor. Typed fields save when you leave them (no undo; retype). Deleted months: Bin, 30 days.

## 17. Export, Drive delivery, publishing

- "Export": a ZIP of every made post as JPG with words and logo, a "clean" folder without words, and a captions CSV. "Feed PDF": the month as one feed PDF. Both free.
- "Deliver to the client's Drive…": final JPGs and captions.txt into a month folder in the client's approved "Outputs" folder; "Approved posts only" or "All made posts"; delivering again updates the same files. Needs the Outputs folder shared with the studio's account as Editor and approved. Free.
- "Publish to Instagram…" (card menu): account, "Now" or "On its date at 10:00" (or a time), preview, "Publish" / "Schedule". A carousel publishes as one post. 9:16 story pictures are refused by Instagram's feed. The card shows "Scheduled …", "Publishing…", "Published ↗" or "Publish failed" ("Retry", "Cancel the schedule").
- "Schedule the approved posts…" (More): queues every client-approved post on its date at 10:00.
- Instagram must be connected by an admin (Connection → "Instagram") with the publishing permission; otherwise "Not connected".

## 18. Costs and safety

- Dollars (image engine, "about $X", always confirmed): making, remaking, "Make another version", "Write a new idea", "Edit this picture", "Enhance (higher quality)", "Restyle", "Try again", the test grid, ambassador portraits, the typography reading.
- Text/vision calls (ideas, drafts, shots, captions, readings, reviews, checks, the planner, the "Ask Firas" assistant): small per-call charges by the text provider, outside the picture budget.
- Credits (Higgsfield/Magnific): AI tools, preset runs, video generate/enhance/check. The provider is asked the cost first.
- Freepik Photo lab: dollars, shown before the run.
- Free: Adjust, Text studio, layouts, typed words, Versions and restoring, export, Feed PDF, client link, Drive delivery, publishing, the video editor, combining cards, animating text, adding AI results as posts or a carousel, browsing presets and styles.
- Spending limit: Admin → "Ask before spending more than ($)"; above it a second approval ("Approve and generate · up to $X").
- Untick the Plan's automatic retake to avoid its extra cost. A double click never sends a run twice; a failed paid run is not retried by itself.
- Preview site: the strip "Preview: image and video generation is blocked at the server." and "Sample data (fictional)": no pictures or videos can be made there.

## 19. Connection and Admin (admins)

- Connection: tabs "Higgsfield" (sign-in for credits; billing "Subscription credits · sign-in" or "Cloud API · pay per clip"), "Claude" (the Anthropic API key: once saved, Claude answers every text call first (plans, ideas, client comments, captions, picture reviews, help, Prompt Box), Google and OpenAI stand in; shows this month's spend against its cap, US$200 by default, editable), "Google", "Google Cloud" (also the Drive account), "OpenAI", "fal.ai", "Freepik" (Photo lab key, stock, Magnific sign-in), "Instagram", "Pinterest" (for "Edit like this video" links), "Notifications" (Resend key, sender, "Send a test e-mail"). A green dot = connected.
- Admin page: "Team" ("Make admin"/"Make member", move a person's months to you), "System check", "Integrations" (one switch per provider, recent operations), "Studio hero video", "Workspace settings" ("Invite code for new accounts", "Ask before spending more than ($)", "Four-stage workflow", "Who sees prices", "Autopilot reviews before paying", "Delete batches after (days)", webhook, notification e-mails).
- New members register on the sign-in page with "Have an invite code? Create an account".

## 20. Common problems

- "The app was updated" / a "Reload" button, or a blank screen after an update: click "Reload" (the page also reloads itself once). Work is saved on the server.
- An AI tools run failed but credits were taken: an admin clicks "Check again" on the result (free). For clips: Video studio → "Versions" → "Check again".
- A preset or AI tool says the post has no picture: make the picture first ("Make the picture").
- "Admins only for now": ask an admin (Firas).
- "Not connected" / "No image engine is connected": an admin connects one in Connection.
- "Blocked" on the Plan: read the reason; usually a missing product photo ("Choose a product image") or an offer missing products, price or contents.
- "Older idea": "Make it again" or edit the picture. "Needs review": "Edit this picture" (paid) or "Accept" (free).
- "Generation stopped.": click "Resume". "The theme changed after these ideas were written.": "Regenerate ideas" if posts should follow it.
- Can't find a colleague's month: members see only their own months; ask an admin.
- The client still sees the old picture: they answered that post; click "Send it for review" on the card.
- A render stopped: "Render again" and keep the tab open.
- Drive shows nothing or "Not connected · demo listing": the folder is not shared with the studio's account, not approved, or Google Cloud is not connected.
- Wrong picture shape: "Wider than … · Crop" chip, or Adjust → "Crop" (free).
- "Save failed": click "Retry"; the edit is kept.

## 21. Not possible in the studio today

- Publishing videos, Reels or Stories to Instagram (pictures and carousels only), or publishing to TikTok, Facebook or other platforms.
- Instagram's music library in a video (add it in the Instagram app when posting).
- A precise mask or pixel-locked AI edit ("Mark an area" only guides; the whole picture is redrawn).
- Making carousels by talking to the planner, or carousels over 10 slides.
- Automatic translation of captions or headlines.
- WhatsApp notifications to the team when a client answers (e-mail only).
- Expiring, password-protecting or renewing the client link.
- Changing or resetting a password in the studio (ask an admin).
- Rendering videos on the server (the browser tab must stay open).
- Members running AI tools, presets, the Photo lab, Freepik stock or video generation.
- A member seeing another member's months.
- Recovering a month after 30 days in the Bin or after "Delete for good".
- An Arabic studio interface (screens are English; the "Ask Firas" assistant answers in Arabic).
`;
