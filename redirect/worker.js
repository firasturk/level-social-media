// The studio moved from the "level-social-media" Worker to the short address below.
// This Worker only sends every old link to the same path there.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://levelstudio.pages.dev${url.pathname}${url.search}`, 301);
  },
};
