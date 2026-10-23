/** The studio's how-to guide the Help assistant answers from (server/help.ts). Keep it true to the UI: update it with every change to a label or flow. */
export const HELP_GUIDE = `
# Level Studio: how-to guide

Level Studio is Level MENA's social-media post studio. For each client it plans a month of Instagram posts, makes the pictures with AI (or takes the client's own pictures and clips), puts the words and logo on them, makes videos, sends the month to the client for approval, delivers it to the client's Drive and can publish to Instagram. Every screen is in English; the labels below are written exactly as they appear.

Golden rule: nothing that costs money or credits runs without a confirmation that says what it touches and what it costs. Earlier pictures are never thrown away: they stay under Versions.

## 1. Words used in the studio

- Client: a brand the agency works for (left menu, under Clients).
- Month: one client's month of posts. A month can hold several "grids" (separate sets of posts, each with its own client link).
- Post: one item of the feed. A carousel counts as one post.
- Design: every slide or tile that is designed. A 4-slide carousel is 1 post and 4 designs.
- Carousel: several slides posted together as one Instagram post (2 to 10 slides). On cards it shows as "Carousel 2/4" (slide 2 of 4).
- Series: posts that belong together but are posted separately ("Series 1/3").
- Separator: a calm post (or a short series) placed between the others.
- Text tile: a tile that is only words and colour (from a grid). It is drawn in the studio for free; no picture is made.
- Take / version: every picture made for a post is kept as a take; the current one is on the card, the others are under Versions.
- Brand kit: the client's colours, fonts, logo, tone of voice, language, rules.
- Theme: the month's look (photos and Pinterest pins that set light, colours and props).
- Style: a look from the Styles library, picked for a post.
- Grid: a picture of a whole Instagram feed; a month can follow it tile by tile.
- Product photo: a real photo of the client's product. It always wins: the product in the picture comes from it.
- Reference picture: a picture pinned to one post to take something from (a background, a light, a mood). It is recreated, never pasted.
- Models (ambassadors): AI people with the same face in every post.
- Credits: the Higgsfield subscription credits or the Magnific balance (used by AI tools, presets and video). Pictures from the main image engine are priced in dollars.

## 2. The main screens

### The left menu
The menu is a narrow rail of icons until you open it (the button at its top: "Open the menu" / "Hide the menu"). It has:
- "Approvals" (admins only): new styles, grids and lessons waiting for approval, with a count.
- "Studio": the selected client's month.
- "Months": every month you can open (with a count), and the Bin.
- "Styles": the style library (address /styles).
- "Video editor": the standalone video editor (address /video-editor).
- "Admin" (admins only).
- "Clients": the list of clients; click one to open it. The "+" ("Add client") adds a client by name.
- At the bottom: the connection button ("Connected" or "Not connected", with the image engine's name) which opens "Image engine connection", your name, the light/dark switch, and "Sign out".

### The four-stage workflow
When the admin setting "Four-stage workflow" is on (it applies to the whole team), the work goes through four stages, shown as numbered buttons at the top: "1 Start", "2 Direction", "3 Plan", "4 Studio".
- Start, Direction and Plan open as a full-screen overlay titled "Create content". Its top bar has a menu button (back to the app's menu), the stages, the client picker, the month picker, the brand kit chip ("Brand kit ready" or "N things missing"), the light/dark switch, and "Skip to the Studio".
- The Studio is the board of the month's posts (section 5). Its top rail repeats the stages ("Back to Start", and so on), a "Classic journey" link and the brand kit chip.
- Nothing costs money on Start and Direction. On the Plan, only the "Make…" buttons spend money, after a confirmation.

### The classic journey
The older step-by-step screens (Account, Products, Posts, Brand kit, Visual identity, Colours, Ideas and dates, Props and shots, Test grid, Generate, Text on design, Feed). Everything it does is also in the four stages. Open it from the Studio's rail ("Classic journey") or from More (the "⋯" button) → "Classic journey". If the admin turned the four-stage workflow off, the Studio shows "Start new journey" and "Open the journey" instead. The client's Instagram/website "Analysis" (client profile) is on the classic journey's first screen.

### Other pages
- "Months" page: every month with its progress; filter by client; open one; delete one (it goes to the Bin). The "Bin" keeps a deleted month 30 days ("Restore", or "Delete for good"). Admins also see "Spend by person".
- "Styles" page: the style library (section 15).
- "Admin" page (admins): Team, System check, Integrations, Studio hero video, Workspace settings (section 19).

## 3. Who can do what (admins and members)

- Members see only the months they created themselves. Admins see every month.
- Members can: plan months, write and edit ideas and words, make pictures with the main image engine (with the cost confirmation), edit pictures with AI ("Edit this picture"), use Adjust, the Text studio, Versions and checks, browse presets, use the client's Drive photos, send the client link, deliver to Drive, export, publish to Instagram (once an admin connected Instagram), add clients.
- Admins only (for now): everything in Connection (keys, sign-ins, Instagram, Pinterest, Notifications), the Admin and Approvals pages, the Photo studio's "AI tools" and running "Presets", the "Photo lab" (Freepik), Freepik stock assets ("Add from Freepik", the Stock tab of Assets), adding an AI tools result as new posts or as a carousel, making, enhancing and checking videos, saving and rendering in the video editor, uploading clips, "Combine into one video", choosing which video the client sees, archiving clients, and renaming, re-ordering or changing the logo of clients in the menu.
- Where something is admins only, the screen says "Admins only for now" and the controls are switched off or hidden. A member should ask an admin (Firas).
- An admin can choose "Who sees prices": if set to admins only, members see "cost shown to admins" instead of amounts. The confirmations still appear.

## 4. Starting a month for a client

1. Pick the client in the left menu (Clients). The studio opens on the current calendar month; change the month with the month picker at the top of the "Create content" screen (or open another month from the Months page).
2. Open the Start stage: in the Studio click "1 Start" (or "Create content" when the month is empty). The Start screen ("Create content") says: "Choose one way to start."

### The four ways to start (four cards)
- "Quick Campaign" ("Turn a brief into a campaign, typed or spoken."), button "Write a brief". Then Direction → Plan → Studio.
- "Follow a grid" ("Plan a campaign from a grid, one post per tile."), button "Pick a grid". Then Direction → Plan → Studio.
- "Edit images" ("Choose one or more images. Edit, style and add text."), tagged "Direct to Studio", buttons "Choose from Drive" and "Upload files".
- "Create or edit video" ("Choose images or clips. Create and edit your video."), tagged "Direct to Studio", buttons "Choose from Drive" and "Upload files".

When the month is already planned, a "Saved plan" line shows its posts, designs and images still to generate, with "Open the plan". What you start then adds to the month or replaces it only when you say so.

### Quick Campaign (a brief)
1. Click "Write a brief" and type (or click "Dictate" to speak) what you want: what the posts show, how many, carousels, colours, any text on them. At least a sentence or two.
2. Optional: "Attach reference pictures" (up to 12). A reference picture is recreated on its post.
3. If the month already has posts, choose "Create new posts" (the current posts stay) or "Replace the month's posts" (the current plan and pictures are kept under Versions).
4. Click "Plan it". This writes a draft (a text call); nothing in the month changes yet.
5. Read the draft ("Draft · not applied"): new posts, existing posts that would change, posts that stay, pictures that would belong to an older idea. Then click the apply button (it says what it does, e.g. "Add 6 posts" or "Replace the month's 12 posts with 15 designs"), or "Discard the draft". "Plan it again" rewrites the draft.
6. "What was understood" shows the objective, posts, products, visual direction and text; you can edit each post's title and scene there (saved when you leave the field).
7. Click "Continue to Direction".

### Follow a grid
1. Click "Pick a grid" and choose a grid from the library (the Styles library's grids).
2. The grid preview shows the picture, its real number of posts and what each tile is (it is read once, a text call, then kept). "Change grid" picks another.
3. If the grid's tile count and your month's post count differ, choose "Use the grid's N posts" or "Adapt to my N posts".
4. "Continue to Direction" asks "Follow this grid" to confirm. The month is planned tile by tile (text tiles, fonts, order). If the month had posts, they are planned again from the tiles; the current plan stays under Versions and pictures already made stay until made again. Product photos are matched to the tiles from the client's Drive.

### Edit images / Create or edit video (Direct to Studio)
1. Click "Choose from Drive" or "Upload files" on the card (both can be combined).
2. The selection dialog: the "Client's Drive" tab lists the client's approved Drive folders (by role, searchable); "This computer" takes uploads. Everything picked goes into one numbered tray; remove any item with its x.
3. Pictures: PNG, JPEG or WebP, up to 20 MB each. Clips (MP4, up to 60 MB) are for admins only; on "Edit images" clips cannot be picked ("A clip: use Create or edit video").
4. Click "Create N and open the Studio". Each file becomes its own card after the month's other posts. Nothing is generated and nothing costs money. The Studio opens with the new cards already chosen (ticked) for the next step: "Apply a style to N chosen", "Open in Text studio", or "Combine into one video" (section 8).
5. If the client or month is missing, the dialog asks for them first.

### Other things on the Start screen
- "Product photos": the month's product photos, with "upload".
- "Campaign size" (or "Saved plan" when the month has posts): click "Edit size" / "Change the size". Fields: "Posts" (a carousel or separator counts once), "Carousels", "Slides per carousel" (2 to 10), "Separators", "Designs per separator", "Format" (Square post 1:1, Portrait post 4:5, Story / Reel cover 9:16). "Save size". For a month that has posts, raising the count offers "Save and add N posts" (new ideas are written; pictures are made later from the Plan). The size is given to the planner when you plan a brief for the whole month.
- "Shortcuts": "Continue from <previous month>" (same theme, colours, props and models, and products), "Open <month> in the Studio", "Fresh grid in <month>" (a new, separate grid in the same month).

## 5. Direction (what shapes the pictures)

Direction says what will shape the pictures. Nothing here spends the picture budget.
- "Leads this month": the way you started (brief, grid, theme references, or one style), with "Start another way" and "Edit the brief" / "Change the grid".
- "Supporting inputs":
  - Pictures pinned to posts: each is recreated on its post. "Pin on the plan" / "Manage" goes to the Plan. "Add from Freepik" (admins) pins a stock picture to one post.
  - "Theme references": the theme's photos and pins; they set light and palette for every post. "Add" / "Manage" / "Hide"; "Analyse the pins" reads them into shots and a palette (a text and vision call).
  - "Grid": "Add a grid" / "Change".
  - "Product images" (section 6).
  - "Models": "Choose models" / "Change models" / "Add a model". In the dialog "Models for <month>", tick "In this month" on up to 3 ambassadors; "Done".
- "When inputs meet on one post, this wins": 1 Product photo › 2 Picture pinned to the post › 3 Applied style › 4 Grid tile › 5 Theme reference. Brand rules and the month's colours apply on top.
- "Rules that apply this month" with "Open the brand memory".
- "Colours": choose where the month's colours come from: "Client's brand colours", "The followed grid's colours", "Both", or "Set by you". "Edit colours" → add/remove colours, "Save colours" or "Keep as they are". The first colour is the background of every post. A month's colours never change the theme.
- "Format and engine": size, engine and about how much per picture, occasions ticked, words (Arabic headline, English second line, caption at most 10 words).
- Footer: "Write the plan" (first time) or "Open the plan".

## 6. Product photos and the client's Drive

- Product photos come from the client's Google Drive folders and this month's uploads.
- In Direction and on the Plan ("Product images"):
  - "Choose for me from Drive": proposes a product image for every post from the brief, the grid and the Drive. Review the list ("Proposed product images · not applied"): "Replace" with another image, "Exclude" / "Include" a post, "Lock" a choice. Then "Use these N product images". No picture is made.
  - "Choose from Drive": browse the client's Drive folders and pick photos yourself.
  - "Upload images": from this computer (also More → "Upload product photos").
- A post whose product has no photo is blocked on the Plan ("Choose a product image" opens a picker with "This month", "Earlier months" and Drive photos).
- Connecting a client's Drive folder: in the Drive picker click "Folders", paste the folder link, choose what it holds ("Product photos", "Brand assets", "References", "Outputs") and approve it ("Approve" / "Approved"). The folder must first be shared in Google Drive with the studio's Google account (shown in the picker) as Viewer ("Outputs" needs Editor, for deliveries). "Not connected · demo listing" means no Google Cloud account is connected (an admin connects it under Connection → Google Cloud).
- Pinning one Drive photo to a post as its reference: post editor → "Idea" → "Reference from the client's Drive" → "Pin to post N", or Photo studio → "Assets" → "Client's Drive".
- Files copied into a month never change if the Drive file changes later.

## 7. The Plan ("The plan, before anything is made")

"Read it and change anything. Making the pictures is the one step that costs money; you confirm it at the bottom."

### Summary at the top
Objective, Product images, Visual direction ("Change"), Models ("Change"), Reference pictures, Output (posts, designs, pictures made and remaining), and "Needs your attention · N" (blocked posts with the reason, missing shots with "Write the shots", other warnings). "Nothing. Every post can be made." when all is fine.

### Tools
- "Talk to the planner" / "Close the planner": the ideas chat (below).
- "Read the scenes before paying": the art director reads each ready post and says what it would take out of the scene before you pay (text and vision calls; no picture is made). Each post's "Read before paying" shows the notes; "Keep my reference attached anyway" when a reference would be left out.
- "Write the ideas again": rewrites the ideas of the whole month (asks first: "Write them again" / "Keep these ideas"). The current posts, words and pictures are kept under Versions; pictures already made are marked "made for an older idea" and are not remade until you ask.
- "Add posts": asks "How many posts to add?" (1 to 12) and writes new ideas in the month's world; the current posts are untouched.
- "Read again": re-reads the plan (states, estimate).

### The post list
Each row: number, picture (if made), "Post and scene" (title, "Shot · …" or "Idea · …"), "Product", "Output · day" (state pill, kind such as "Picture", "Carousel · slide 2 of 4", "Text tile · drawn here, free", and the posting date), and "Details" / "Hide details".
- States: "Ready to make", "Drawn here" (free text tile), "Making", "Made", "Older idea", "Blocked".
- The date field is the posting day; changing it moves the post in the month (its number and pictures stay).
- With models cast: chips per post; "+ model" adds one, the x takes one out.
- "Details": edit "Idea", "Shot", "Words" (headline and caption); conflicts between inputs ("Inputs disagree · decide before paying") with "Allow on this post", "Take the style off" or "Withdraw"; "What will guide this picture".
- Older ideas: a box "N pictures belong to an older idea" with "Make it again · about $X" / "Make those N again · about $X" (only those posts).

### Test grid
"Make the test grid" paints the whole month's feed as one picture before you pay for the posts (one paid picture; the words are drawn on it in the month's fonts). "Make it again" repaints it.

### Making the pictures (the paid step)
The footer shows how many pictures, the engine, the size and "about $X each", the estimate, and the checkbox "If the review finds a problem, retake the picture once by itself" (it raises the maximum; untick it for no automatic retakes).
- "Save the plan, make nothing": everything is already saved; goes to the Studio.
- "Make one test picture · about $X": one post only, to see the look first.
- "Make all N pictures · about $X" (or "Make N pictures · about $X"): asks for confirmation ("Make N · about $X"). Blocked posts are left out. Pictures already made stay; posts with an older idea get another version (the old one stays under Versions).
- If the run is above the admin's spending limit, a second confirmation appears: "Approve and generate · up to $X".
- In the Studio, the button "Make N remaining · about $X" (or "Open the plan") opens this Plan, where the cost is confirmed.
- When the pictures arrive, the studio chimes and says how many are ready. Each picture is reviewed automatically.
- "No image engine is connected" means an admin must connect one in Connection.

### Talk to the planner (the ideas chat)
On the Plan, "Talk to the planner"; in the Studio, the "Prompt" button (titled "Prompt box"). Type or dictate what to change, like to a colleague, e.g. "Post 3 on the kiwi mojito instead, same idea", "Move the Christmas post to the 24th and make it a greeting", "All the captions in Jordanian Arabic, playful, end with a question", "Add a Mother's Day post", "Remove post 5". Enter sends, Shift+Enter makes a new line.
- It can change a post's title, idea, shot, headline, second line, caption, hashtags, date, product and type, add posts, remove posts, and set standing rules for the words.
- If you ask for pictures, it asks "Generate now" (paid) or "Keep the changes, generate later".
- Sentences that ask a tool ("Find a minimal background from Freepik for post 3", "Animate this post using Kling through Higgsfield", "Remove the background of post 2") become a card you read and confirm; nothing runs from the sentence alone. Running tool cards is admins only for now.
- It cannot turn posts into a carousel (see section 9).

## 8. The Studio board

### Header
- Tabs: "Posts", "Feed", "Words", "Client approval", "Versions".
- The month in numbers, e.g. "12 posts · 16 designs · 6 made · 2 need a look · 9 remaining", and the save state.
- "Client answered · N new" badge when the client answered (click: opens Client approval).
- Buttons: "Do client comments (N)" (only when the client asked for changes), "Export", "Client link", "Make N remaining · about $X" or "Open the plan", "Prompt", and "⋯" (More).

### The More (⋯) menu
"Month tools (upload, ideas, grid, overlay, typography, PDF)" / "Hide the month tools", "Send the client link on WhatsApp", "Feed PDF", "Deliver to the client's Drive…", "Schedule the approved posts…", "Upload product photos", "Products, versions and brand kit" / "Hide the side panel", "New grid in this month", "Classic journey", "Delete this month".

The side panel ("Products · versions · brand kit" on the left) holds the month's "Products", "Notes and grid", "Earlier versions", and the brand kit sections (section 14).

The month tools bar (opened from More) has: "Month", "Grid" (when the month has several grids), "New grid", "Posts" (count), "Upload products", "Generate ideas" / "Regenerate ideas", "From reference grid", the generate button ("Generate posts", "Generate N posts", "Regenerate N posts", "Regenerate all"; these make pictures, so they cost money), "Overlay" (show or hide the words drawn on the cards), "Export", typography ("AI picks for each post" and the typography styles such as "Behind the product", "Crossing the product", "Repeated", "Big outline"; this reads each picture with AI, a paid call), "Feed PDF", and the bin icon "Delete this month".

### Tabs
- "Posts": the cards (below).
- "Feed": meant to show the month as an Instagram feed. In the four-stage workflow it can open the workflow screens instead; reliable ways to see the feed: More → "Classic journey" (its last screen, "Feed"), More → "Feed PDF", or open the client link.
- "Words": every post's "On the picture" (headline), "Caption" and "Hashtags", in date order; carousel slides say "carousel slide n of m". Each field saves when you leave it. Free.
- "Client approval": the client's answers (section 12).
- "Versions": "Earlier versions of this month: every take of every post, and the plans replaced by a replan." Open one and click "Use this version in the studio", or "Use for post N" on one picture.

### A post card
At the top of the picture:
- The number, the post type ("Product", "Lifestyle", "Offer", "Tip", "Quote", "Announcement", "Behind the scenes", "Testimonial", "Occasion greeting"; the client's own pictures and clips have no type), and a format chip: "Post" (a single picture) or "Carousel 2/4" / "Series 1/3".
- The posting day (e.g. 10/14).
- The state: "Idea" (no picture yet), "Queued", "Generating…", "Paused", "Made", "Ready" (client's own picture), "Accepted by the team · <name>", "Older idea", "Failed", or "Needs review".
- Small icons (when there is a picture): aperture = "Photo studio", T = "Text studio", clapperboard = "Video studio".
- "Wider than 4:5 · Crop" (or "Taller than …"): the picture is not the month's format; click to crop it in the Photo studio's Adjust (free).
- When the post has a video, the clip plays on the card with "the client sees this" or "not the client's version".

Under the picture: the title, the client's answer chip ("Client approved · <name>" or "Client asks a change · <name>"), the product and "Style: <name>", then the actions.

What the states mean:
- "Needs review": the automatic review found something (the card names it). "Edit this picture" fixes it with an AI edit (one paid picture); "Accept" keeps it as it is (free; the client's approval is separate).
- "Older idea": the idea, product or direction changed after the picture was made. The main button becomes "Make it again · about $X" (a new version; the old one stays under Versions). You can also bring it up to date with "Edit picture".
- "Failed · <reason>": the main button is "Try again · about $X".

Buttons:
- Main button when there is no picture, a failure or an older idea: "Make the picture · about $X" / "Try again · about $X" / "Make it again · about $X". Each asks first and changes only this post.
- "Edit picture" (when there is a picture): opens the Photo studio. "Edit the idea" (no picture yet): opens the post editor on the idea.
- "Words & caption": opens the post editor on "Words & design" (free).
- On the client's own pictures with a saved style: "Restyle · about $X" (one paid AI edit into that style's look).
- "⋯" (More actions) on a planned post: "Make another version" (a fresh picture of the same idea, paid), "Write a new idea" (a fresh idea for this post, then its picture is made again right away: one paid picture), "Pick a style" / "Change the style" / "Take the style off", "Enhance (higher quality)" (an AI edit at higher quality, paid), "Open the Text studio", "Animate the text", "Video from this picture", "Publish to Instagram…", "Previous picture" (when available), "Reference picture and versions", "Remove this post".
- "⋯" on the client's own picture: "Pick a style" / "Take the style off", "Open the Text studio", "Video from this picture", "Publish to Instagram…", "Previous picture", "Versions", "Remove this post".
- Clicking the picture opens the post editor.
- "Remove this post" takes it out of the month at once (its picture is kept with the month's earlier versions).
- A card can show "Unsaved edits kept: …" with "Open to finish" or "Discard" (edits you left in a studio without saving).

### Choosing several cards
Click "Choose cards" (above the cards), tick the cards (each shows its order number). The bar shows "N cards chosen" and:
- "Apply a style to N chosen": saves a style on those cards (no picture is made, nothing is paid). Each picture is then restyled on its own card with "Restyle", confirmed with its cost.
- "Open in Text studio (1 of N)": opens the Text studio on them one by one.
- "Combine into one video" (admins, at least two cards): see section 11.
- "Clear", and the x ("Stop choosing cards").

## 9. Carousels and series

A carousel is a group of posts with slide numbers ("Carousel 1/4", "2/4"…). It is published as one Instagram post (2 to 10 slides, every slide needs a picture). The ideas chat cannot group posts; make carousels one of these ways:

1. From a brief (Quick Campaign): write it in the brief, e.g. "a carousel of 5 slides that reveals the new cup", or set "Carousels" and "Slides per carousel" in "Campaign size" on Start and then "Plan it" for the whole month. Apply the draft; the slides appear as posts with "Carousel n/m".
2. From a grid: when the grid's reading has carousels or series, they are planned that way.
3. From an existing post, with the Photo studio's AI tools (admins):
   - Open the post's picture: card → "Edit picture" → rail "AI tools".
   - Pick a tool (for example "Variations", "Restyle", "Reimagine", "Change camera"), fill its options, "Get the cost" (optional), then "Run …" and confirm the credits.
   - When the result is ready, under it click "Add as a carousel": the post becomes slide 1 and the result becomes the next slide(s). Nothing is run or paid for this step.
   - "Variations" gives nine pictures: "Add as a carousel" puts all nine after the post (10 slides, the maximum). For other tools one picture is added. Run more tools and add each result to make more slides.
   - A carousel holds at most 10 pictures; if it would go over, add them as new posts instead. A post that is part of a series cannot become a carousel.
   - The other choice is "Add as a new post" ("Add each picture as a new post" for Variations): the result becomes new single posts after the month's posts, copying the original's idea and words.
4. Each slide is its own card with its own picture, words and versions; edit them like any post.

## 10. The Photo studio (full-screen picture editor)

Open it with "Edit picture" on a card, the aperture icon on the card, "Open the Photo studio" in the post editor's Image group, or "Photo studio" from the Text or Video studio. It needs a picture (a post without one opens the editor on its idea).

Top bar: "Photo studio · post N · <title>", the state ("Ready", "Review", "Making…", "Failed"), "Adjustments not applied" when pending, a note when the client holds the picture (section 12), undo/redo (adjustments), "Versions · N", "Text studio", "Video studio", "Save & return", and the x (close). Closing with unsaved work asks "Save & return" or "Keep for later" (kept edits wait on the card).

Keys: [ and ] previous/next post, Z fit or 100%, hold C to see the product photo (in Adjust: the picture before), Esc closes the active tool then the studio, Ctrl/Cmd+Z undo adjustments.

The rail, in order: "Presets", "AI tools", "Edit", "Adjust", "Photo lab", "Assets", "Versions", "Check". A small lock marks tools that are admins only. On a phone, Presets and AI tools share one "AI" button at the bottom.

### Edit (Edit with AI)
- Canvas view: "Compare" (product photo and result with a slider), "AI result", "Original".
- Write the instruction (or "Dictate the change"); "Mark an area" lets you drag a box (it is put into the instruction in words; it is not a mask, the whole picture is redrawn).
- "Quick instructions": "Background", "Lighting", "Composition", "Remove an object", "Product correction", "Blend with scene", "More brand colour", "Cleaner background", "Leave headline space", "Match product", "Remove text", "Brighter", "Closer".
- "Attach a reference for this edit" (a background, a light or a mood to take from); "Change" / "Take off". It stays on the post for its next takes.
- "Edit this picture · about $X": one paid picture after a confirmation; only this post changes; the old picture stays under Versions; words and logo are redrawn over the new one.
- "Or start over": "Make another version · about $X" (a fresh picture from the saved idea, not from this picture; paid).
- Anyone working on the month may use it.

### Adjust (free)
"Free · drawn here". "Crop" with Free, 1:1, 4:5, 9:16 (drag the frame's handles), turn left/right 90°, flip, "Straighten", then "Exposure", "Contrast", "Saturation", "Temperature", "Tint", "Highlights", "Shadows", "Sharpen", "Vignette" (double-click a slider to reset it). "Hold for before", "Reset". "Apply as the post's picture" makes the adjusted picture the post's picture (free, nothing generated); the old one stays under Versions.

### Presets
A gallery with the providers' sample pictures, in four categories: "Styles" (Higgsfield Soul picture styles), "Product shots" (Higgsfield product-shot presets), "Magnific looks", "Recipes". Search ("Search presets") and refresh. Browsing is free and open to everyone ("You can browse every preset; using one on a picture is admins only for now").
- Click a card to see it in full: what it "Needs:", "Cost:", "Ready?", "Learn more".
- "Use this style" / "Use this look" / "Use these words": opens AI tools with it filled in.
- Product shots: "Use this preset" opens the detail; under "Run it here" an admin fills "The product (sent first, so the engine keeps it)" (filled in from what the studio knows; correct it), any text fields (e.g. your change), then "Run this preset · N credits" (or "· cost not known") and confirms. It needs the post to have a picture ("This post has no picture yet; the preset needs one."). The result appears in AI tools.

### AI tools (admins only for now; paid in credits)
Two providers (tabs): "Higgsfield" (subscription credits) and "Magnific" (Magnific balance).
- Higgsfield: "Upscale", "Remove background", "Outpaint" (more picture around the edges, new frame), "Relight", "Generate with a style" (a Soul style from your words).
- Magnific: "Upscale" (presets and modes), "Relight", "Remove background", "Replace background" (describe the new scene), "Retouch" (small fixes from words), "Skin enhancer", "Expand", "Restyle" (the same picture in another look), "Reimagine" (a fresh take that keeps the idea), "Change camera" (another angle: Front, From the left, From the right, From above, Low angle, Closer, Wider), "Variations" (nine close variations).
- A tool the provider does not list today shows "not listed" and is refused before anything is sent.
- Steps: pick the tool, fill its options ("Needed first: …" lists missing ones), "Get the cost" (asks the provider; nothing is made; shows "About N credits · balance M" or "Cost not known"), then "Run <tool> · N credits". A confirmation names the credits ("Run · N credits", or "Run it anyway, cost unknown" for Higgsfield; Magnific with an unknown cost is blocked).
- The result shows before and after on the canvas (drag the slider). Then: "Use as the post's picture" (the old picture stays under Versions), "Save as a product photo" (adds it to the month's product photos), "Download", "Add as a new post" / "Add each picture as a new post", "Add as a carousel". For Variations there is no "Use as the post's picture": add them as posts or a carousel. After adding, the button says "Added as post N".
- If a run shows as failed, an admin can click "Check again": it asks the provider whether the run finished after all (free; nothing is run again) and collects the result if ready.
- "Earlier results (N)" lists previous runs of this post; click one to show it again.
- The tools need a picture: "This post has no picture yet; the tools need one."

### Photo lab (admins only for now)
Freepik's real-photo tools, priced in dollars: "Remove background", "Replace background", "Relight", "Upscale". Picture source: "This post's picture" or "Client's Drive photos". "Run … · about $X" asks for confirmation. Then "Use as the post's picture", "Save as a product photo", "Download". "Demo · not connected" means no Freepik key (the result is a demo).

### Assets
Two tabs: "Stock" (Freepik, admins only for now: search, then "Add as layer", "Set as background", "Use as reference", "Save to library"; layers and backgrounds open the Text studio with the asset placed, free) and "Client's Drive" (the client's photos, pinned to this post as the reference for its next AI edit; everyone).

### Versions
Every take of the post, newest first: "Current picture" / "Earlier take" / "Failed", date, cost, note, and whether it was made for the idea as it is now. "Compare" (with the current picture, or pick two takes), "Edit this version" (the Photo, Text and Video studios work on that take; the post's picture changes only when you apply an edit), "Use this picture" (puts that take back as the post's picture), "Previous picture", the video versions, and "The month's earlier versions".

### Check
"Automatic review": what the review found, with "Edit this picture" (paid) and "Accept as it is" (free). "Writing check (OCR)": "Check the raw picture" (nothing should be written on the picture except the product's packaging) and "Check the final artwork" (the headline, second line and price must read exactly as approved). One reading per click when Google Vision is connected; otherwise a demo result says "Not connected · demo result".

## 11. Words on the picture, captions and languages

### Where the words live
- Headline ("On the picture"), second line, caption and hashtags are saved with the post. The headline, second line and logo are drawn over the picture as layers: changing them is free and never remakes the picture.
- Letters the engine drew inside the photo are part of the picture and cannot be retyped; "Edit this picture" with the quick instruction "Remove text" removes them (one paid picture).

### Changing the text on a post
- Quick: the "Words" tab, or the card's "Words & caption" button.
- Post editor → "Words & design": "Headline: drawn on the picture", "Second line", "Text on the image" (untick for a text-free picture; the caption still posts), "Dark fade behind the words", "Caption: posted with the picture, not drawn on it", "Dictate the caption", "Write the caption from the picture" (a text call), "Hashtags", "Language for this post", "Save".
- "Check the words": the art director looks at the post as published (do the words cover the product, do they read?). Tick "Apply its moves by itself", or choose "Apply the moves" / "Leave the words as they are".
- Captions are written automatically from the picture when a picture is made or remade, unless you wrote the caption yourself. The client's own pictures are not captioned automatically: use "Write the caption from the picture".
- Placing and styling the words: the Text studio.

### Languages
- Brand kit → "Content language": "Arabic", "English", or "Arabic and English (bilingual layouts)". It is the default for captions, headlines and the Text studio's layouts and fonts.
- One post can differ: post editor → "Words & design" → "Language for this post".
- Nothing is translated for you automatically. To translate a text layer, use the Text studio's "Assistant" → "Translate…". To rewrite many captions in another language, ask the planner (e.g. "All the captions in Jordanian Arabic").

### The Text studio
Open it with the T icon on a card, the card menu "Open the Text studio", the post editor's "Open the Text studio", or "Text studio" from the Photo or Video studio. It needs a picture and "Text on the image" on. Nothing here makes a new picture; it is free.
- Top bar: "Text studio · post N", the save state ("Saved", "Saving…", "Unsaved changes"; on a post the client answered: "Draft: not on the client's link yet"), undo/redo, "Apply this style to all posts" (the same line on every post of the month gets this look; their words stay), "Preview" (the final artwork), "Photo studio", "Video studio", "Export" ("JPG · high quality", "Text only · transparent PNG", "PDF", "Back to the automatic layout"), "Save & return".
- Left tabs: "Layers" (the "Add" menu: "Text" (key T), "Logo", "Image…", "Rectangle", "Ellipse", "Line", product photos, brand assets; reorder, duplicate, hide, delete), "Layouts" (whole arrangements of the words for this post: "Preview", "Apply", "All designs…" to apply to every design of the month after a confirmation), "Styles" (the look of one layer: outline, neon, gradient…; save your own), "Brand" (brand fonts and colours, upload a font).
- Right tabs: "Properties", "Assistant" ("Rewrite", "Shorten", "Expand", "Headline ideas", "Call-to-action ideas", "Fix spelling", "Translate…", "Brand tone", "Judge the layout"; suggestions only, nothing changes until you apply one), "Assets" (Freepik icons, photos, backgrounds and lettering as layers; admins only for now).
- Toolbar: size, weight, bold/italic/underline, alignment, reading direction ("Auto", "RTL", "LTR"), spacing, opacity. Safe zones (where Instagram's buttons sit), keyboard shortcuts (?).
- Vector (SVG) layers: "Split into layers", "Remove background", "Merge back".
- "Save & return" saves and goes back to the card (it also saves pending edits from the Photo or Video studio of the same post).

### Animate the text
Card menu "Animate the text" (or "Animate" in the post editor): a short video of the post's words moving over its picture ("Motion", entry and hold times), exported from the browser ("Export …"). Free; the picture does not change.

## 12. Client approval (sending the month to the client)

### Sending the link
- "Client link" (Studio header) or "Copy the client link" (Client approval tab) copies the approval link; send it to the client. Or "Send the client link on WhatsApp" (More) / "Send on WhatsApp" (Client approval tab) opens WhatsApp with a ready message.
- One link per month (per grid). It stays the same each time and needs no sign-in. The client sees the latest picture of each post at once.

### What the client sees
The client's page: "<Client> · <Month>", "N posts ready · N approved". They write their name once ("Reviewing as …"). "The feed" shows the month as an Instagram profile grid. Each post shows its picture with the words and logo (or its video), the caption and hashtags, "Version currently shown", and the buttons "Approve" and "Ask for a change". "Ask for a change" offers reasons ("Change the words", "Change the picture", "The colours", "The product looks wrong", "Another date") and a note, then "Send". When everything is approved the page says "Everything is approved. Thank you!". Posts without a picture yet say "Being prepared".

### Reading the answers
- The "Client approval" tab: "N approved · N to change · N not seen yet"; each post with "Client approved", "Change asked", "Not seen yet" or "No picture yet", who answered, their note and when; "Open the post".
- The Studio header shows "Client answered · N new"; the cards show "Client approved · <name>" or "Client asks a change · <name>".
- "Do client comments (N)": reads what the client asked, writes it into those posts (words, idea), then asks "Generate now" (paid) or "Keep the changes, generate later".
- "Client feedback · the month" (bottom of the Client approval tab; also "Client feedback on this post" in the post editor's Idea group): paste or dictate feedback received elsewhere (e.g. WhatsApp), "Read the feedback". It is split into changes (layer edit and new words are free; a picture edit is paid and confirmed first; or a new idea). For each change: check the post/slide, then "Approve", "Reject", "Apply".
- E-mail: on the Client approval tab switch on "Email me when <client> answers". One e-mail per month is sent about ten minutes after the client's first answer (or at once when every post has an answer). If nobody switched it on, every admin gets it. It needs the Notifications key (Connection → Notifications, admins).

### The client hold (posts the client already answered)
A post the client has answered (approved, or asked for a change) keeps the client's version on the link. An edit on such a post (an Adjust, an AI edit result used as the picture, new words, a new video render) is saved as a new version but does not replace what the client sees. The editors say "Client approved: saving makes a new version" (or "Client asked for a change: …").
- The card then says the edit is saved as a new version, with "Send it for review" (makes the new version the client's; the client's earlier answer is cleared so they answer again) and "Keep the client's" (hide the note; the new version stays under Versions).
- In the Text studio, "Save & return" on such a post asks "Save and send for review" or "Keep as a draft".
- "Use this picture" or "Previous picture" on such a post asks "Use it and send for review" or "Keep the client's".
- A post the client has not answered is edited directly; the link shows the change at once.

## 13. Video

### Video studio (a post's videos)
Open it with the clapperboard icon on a card or the card menu "Video from this picture" (also "Video studio" from the Photo/Text studio, "Open the Video studio" in the Video dialog). Top bar: "Versions · N", "Photo studio", "Text studio", close. The rail: "Presets", "Generate", "Edit", "Enhance", "Audio", "Versions", "Check".
- "Presets": Higgsfield's preset gallery, each with its reference video (categories "Popular", "Paid Ads", "Motion Design", "Marketing", "Production", "Faceless", "Effects", "Genjutsu", "Recipes"). Browsing is free for everyone. "Use this preset" fills Generate; "Run this preset · N credits" is admins only.
- "Generate" (admins only for now): a clip from the post's picture. Write the motion idea (or click to write it from the picture, or dictate), choose the provider ("Higgsfield" or "Magnific") and engine, length and frame (Reel 9:16 by default; Portrait 4:5, Square 1:1, Landscape 16:9), "Include the words and logo in the video input", "Get the cost", then "Make the video · N credits". Higgsfield bills the subscription credits or the Cloud API, as the admin chose in Connection.
- "Edit": the video editor (below).
- "Enhance" (admins): Magnific "Upscale", "Colour grade", "Music", "Sound effects", "Relight", "HDR"; Higgsfield "Upscale", "Reframe", "Remove the background". Each asks the cost first; the result is a new version.
- "Audio": the sound each version carries (admins change it; members read it).
- "Versions": every clip of the post: "Show" / "Compare", "Select for client review" (admins), "The client sees this", "Show the picture instead", "Edit", download, and "Check again" on a failed clip. The first finished clip becomes the client's version by itself when the client has not answered the post.
- "Check" (admins): Higgsfield's "Virality check" and "Video analysis" of a clip (cost asked first).

### The video editor
Inside the Video studio ("Edit") or alone from the left menu "Video editor" (no post: footage from this computer, the result saved as a file). Tabs: "Media", "Text", "Logo", "Music", "Colour", "Auto edit", "Render". Everything is drawn in your browser; nothing is paid. Saving and rendering are admins only for now (members can look).
- "Media": templates gallery at the top ("Use the template" fills the cut from the footage; undo brings your cut back), the footage list (add a clip to the timeline; add an MP4/MOV from this computer, 60 MB at most), and the selected clip's trim, speed, sound and join.
- "Text": words over the video (Arabic, English or both). "Logo": the logo or a picture over the video, "From the asset library".
- "Music": "Browse the music library" (tabs "Catalog" and "<Client> tracks", moods, genre, length, tempo; "Use in this video"; each track shows its licence and credit), or a track from this computer (with its licence line). "Beats": "Align cuts to beats". "Voice-over".
- "Colour": presets, corrections, LUT, "Match colour to a reference".
- "Auto edit": "A first cut": "Purpose" ("Product launch", "Promo", "Story"), "Length", pace ("Calm", "Balanced", "Energetic"), words on the hook and end card, "Build the cut" (replaces the timeline; undo brings it back; locked clips stay). "Edit like this video": give a video, a Pinterest pin or a clip whose editing you like; your footage is cut the same way (Pinterest links work best when an admin connected Pinterest in Connection).
- "Render": frame and quality, then "Render & update card" (or "Render to a file" in the standalone editor). Rendering happens in your browser: keep the tab open until it finishes. "Save draft" keeps the editable project. If the client answered the version they see, the new render waits: "Send for review (make it the client's version)".
- Top bar: undo/redo, split at the playhead (S), "Save draft", "Render & update card".
- The open-source licences of the editor's software are at /licences (link "Open-source licences" under Render). Music licences are shown per track in the music library.

### Combining cards into one video
"Choose cards" → tick at least two → "Combine into one video" (admins). Put them in order, choose "Save the project on" ("A new card" or one of the posts), then "Combine N and open the editor". Pictures join as 3-second clips drawn in your browser. Nothing is generated or paid; then edit, add music and render in the Video editor.

### Video dialog
The post editor's "Video" button opens the older Video dialog (a short video from the picture, engine credits); it has "Open the Video studio" at the top.

## 14. Clients and the brand kit

- Add a client: left menu → "+" next to Clients ("Add client"). Admins can also "Rename client", "Change logo", "Move up" / "Move down", "Archive client" / "Restore client".
- The brand kit is in the Studio's side panel (More → "Products, versions and brand kit", or the "Products · versions · brand kit" rail, or the brand kit chip at the top). Sections:
  - "Brand kit": logos, "Place photos", "Real people", "Brand colours", fonts ("Headline font", "Body font"), "Tone of voice and language" ("Content language"), "Rules", "Past posts (identity)".
  - "Brand ambassadors": AI people with the same face in every post. Add one by name, describe the look, then "Generate portrait" (one paid picture) or "Upload" a portrait; tick "In this month" on up to 3.
  - "Theme": "Theme of the month" (or "No theme (brand identity only)"), "New theme", rename, "Delete", "Photos and pins" ("Add photos" / Pinterest links), "Visual language", "Colours this month", props, wardrobe, "Shots from the references".
  - "Overlay": how the headline, second line and logo are drawn over each post (layout, brand font files, logo, corner, headline, second line, spacing).
  - "Brand memory": approved brand rules, this month's instructions, and lessons waiting for approval.
  - "Output": "Image engine", "Post size", "Resolution", "Posts per month", and "Exact product: place the real photo, never redraw it" (the real product photo is set into the scene; posts with one product, nobody holds it).
- The brand kit chip says "Brand kit ready" or "N things missing".

## 15. The Styles library

Left menu → "Styles". Product-photo styles and feed grids, read from Pinterest and the team's own pictures. Tabs include "All", "Trends", "Grids" and the style categories.
- "Add" (paste Pinterest links; "Feed grids" for whole feeds; related pins can come along) or upload pictures. A member's additions wait for an admin's approval (left menu "Approvals": "Grids to approve", "Styles to approve", "Lessons learned").
- Select styles to "Add to a client's…" library, to write them again (a fresh take), or to replace them with new ideas.
- A style picked for a post (card menu "Pick a style") is written for that post's own product and brand: its idea and shot change; making the picture is a separate, confirmed step.

## 16. Versions, undo and restoring

- Every picture is kept. Post editor → "Versions" (or the Photo studio's "Versions"): "Compare", "Use this picture" to put an earlier take back.
- "Previous picture" (card menu, post editor) brings back the picture from before the last remake.
- The month's "Versions" tab / side panel "Earlier versions": whole earlier plans and pictures; "Use this version in the studio" brings one back (the month as it is now is kept as a version), "Use for post N" brings back one picture.
- Undo/redo buttons exist in the Photo studio (adjustments), the Text studio and the video editor (timeline). Words typed in fields save when you leave the field; there is no undo for those, retype them.
- A deleted month stays in the Bin (Months page) for 30 days: "Restore".

## 17. Delivering, exporting and publishing

- "Export" (Studio header): a ZIP with every made post as a JPG with its words and logo, a "clean" folder without words, and a captions CSV. Free.
- "Feed PDF" (More): one long PDF page with a cover, the month as an Instagram feed and a note per post. Free.
- "Deliver to the client's Drive…" (More): writes the final artwork (JPGs) and a captions.txt into a month folder inside the client's approved "Outputs" Drive folder. Choose "Approved posts only" or "All made posts". Delivering again updates the same files. Needs an "Outputs" folder shared with the studio's Google account as Editor and approved in the Drive picker; the dialog says what is missing. Free.
- Publishing to Instagram: card menu "Publish to Instagram…": choose the Instagram account, "Now" or "On its date at 10:00" (or a time), check the artwork and caption, then "Publish" or "Schedule". A carousel is published as one post from any of its slides. Instagram refuses 9:16 story-format pictures in the feed. The card then shows "Scheduled …", "Publishing…", "Published ↗" or "Publish failed"; the dialog offers "Cancel the schedule" and "Retry".
- "Schedule the approved posts…" (More): queues every post the client approved that is not already scheduled or published, each on its own date at 10:00.
- Publishing needs an admin to connect Instagram (Connection → "Instagram") with a Meta token that has the publishing permission. Otherwise the dialog says "Not connected".

## 18. Costs and safety

- Money (dollars, list-price estimates): every picture from the image engine (making, remaking, "Make another version", "Write a new idea", "Edit this picture", "Enhance (higher quality)", "Restyle", "Try again", the test grid, ambassador portraits, the typography reading). Each says "about $X" and asks first.
- Text and vision calls (ideas, drafts, shots, captions, "Read the scenes before paying", reviews, checks, the planner chat, the Help assistant) are billed per call by the text provider, outside the picture budget; small amounts.
- Credits: the Photo studio's AI tools and Presets runs, and video Generate/Enhance/Check/Presets, use the Higgsfield subscription credits or the Magnific balance. The cost is asked of the provider first; an unknown cost is either confirmed on purpose (Higgsfield) or blocked (Magnific).
- Freepik Photo lab: dollars, shown before the run.
- Free: planning screens without generation, Adjust, the Text studio, layouts, words and captions you type, Versions, restoring, export, Feed PDF, the client link, Drive delivery, publishing, the video editor (rendered in the browser), Combine into one video, Animate the text, adding AI results as posts or a carousel, browsing presets and styles.
- Spending limit: the admin's "Ask before spending more than ($)" (Admin → Workspace settings). A run above it needs a second approval ("Approve and generate · up to $X").
- The automatic retake (Plan checkbox) remakes a picture once by itself if the review finds a problem; untick it to avoid that extra cost.
- A run is never sent twice by a double click; a failed paid run is not retried by itself.
- Preview site: a strip says "Preview: image and video generation is blocked at the server." and data may be "Sample data (fictional)". Pictures and videos cannot be made there; use the real studio.

## 19. Connection and admin settings (admins)

- Connection (left menu bottom): "Image engine connection" with tabs "Higgsfield" (sign-in for subscription credits and the billing choice "Subscription credits · sign-in" or "Cloud API · pay per clip"), "Google", "Google Cloud" (also the Drive account), "OpenAI", "fal.ai", "Freepik" (Photo lab key, stock, Magnific sign-in), "Instagram" (Meta token for profiles and publishing), "Pinterest" (for "Edit like this video" pin links), "Notifications" (Resend key and sender for client-answer e-mails; "Send a test e-mail"). A green dot means connected. Only admins can change them.
- Admin page: "Team" (users, roles "Make admin" / "Make member", move a person's months to you), "System check", "Integrations" (one switch per provider, recent operations), "Studio hero video", "Workspace settings": "Invite code for new accounts" (empty closes registration), "Ask before spending more than ($)", "Four-stage workflow", "Who sees prices", "Autopilot reviews before paying", "Delete batches after (days)", Slack/Discord webhook, notification e-mails.
- New team members create an account on the sign-in page with "Have an invite code? Create an account" (the invite code comes from an admin).

## 20. Common problems

- "The app was updated" / a "Reload" button appears, or a screen goes blank after an update: click "Reload" (the page also reloads itself once when a screen's code changed). Your work is saved on the server.
- An AI tools run shows "failed" but credits were taken: an admin clicks "Check again" on the result; it collects the picture if the provider finished it (free). For video clips, "Check again" is in the Video studio's Versions.
- A preset or AI tool is greyed out or says the post has no picture: make the post's picture first (card → "Make the picture"), then use the tool.
- "Admins only for now": the action spends a provider's credits or changes a connection; ask an admin (Firas).
- "No image engine is connected" / "Not connected" at the bottom of the menu: an admin must connect an engine in Connection.
- A post is "Blocked" on the Plan: read the reason; usually its product has no photo ("Choose a product image") or an offer's products, price and contents are not filled.
- A card says "Older idea": the idea or product changed after the picture was made; "Make it again" or edit the picture.
- "Needs review": fix with "Edit this picture" (paid) or "Accept" (free).
- "Generation stopped." on the month: click "Resume".
- "The theme changed after these ideas were written.": click "Regenerate ideas" if the posts should follow the new theme.
- I cannot find a month someone else made: members only see their own months; ask an admin.
- The client says they still see the old picture: the client answered that post, so your edit waits as a new version; click "Send it for review" on the card.
- A render stopped: rendering runs in the browser; press "Render again" and keep the tab open.
- The Drive picker shows nothing or "Not connected · demo listing": the folder is not shared with the studio's Google account, not approved, or Google Cloud is not connected (admins).
- The picture's shape is wrong: use the "Wider than … · Crop" chip, or Photo studio → "Adjust" → "Crop" (free).
- "Save failed": click "Retry" on the message; your edit is kept.

## 21. Not possible in the studio today

- Publishing videos or Reels, or Stories, to Instagram: publishing is for pictures and carousels only. Publishing to TikTok, Facebook or other platforms is not available.
- Adding Instagram's own music library to a video: only tracks with a licence from the studio's music library or uploaded files; Instagram music is added in the Instagram app when posting.
- A precise mask or pixel-locked AI edit: "Mark an area" only guides the instruction; the whole picture is redrawn.
- Making carousels by talking to the planner: use a brief, the campaign size, a grid, or AI tools → "Add as a carousel".
- Carousels of more than 10 slides.
- Automatic translation of captions or headlines: nothing is translated by itself (use the Text studio Assistant's "Translate…" on a layer, or ask the planner to rewrite).
- WhatsApp notifications to the team when a client answers: only e-mail exists.
- Expiring or password-protecting the client link, or making a second link for the same grid.
- Changing or resetting your password from the studio: there is no password reset or change screen; ask an admin.
- Rendering videos on the server: renders happen in your browser, so the tab must stay open.
- Members running AI tools, presets, the Photo lab, Freepik stock or video generation: admins only for now.
- Seeing another member's months as a member.
- Recovering a month deleted more than 30 days ago, or one deleted "for good".
- A studio interface in Arabic: the screens are in English (the Help assistant answers in Arabic).
`;
