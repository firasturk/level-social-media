// The studio moved from the "level-social-media" worker to "studio" (a shorter address).
// This worker only sends every old link to the same path on the new address.
export default {
  fetch(request) {
    const url = new URL(request.url);
    const rest = url.hostname.split(".").slice(1).join(".");
    return Response.redirect(`https://studio.${rest}${url.pathname}${url.search}`, 301);
  },
};
