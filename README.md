# Brush v1 (Alpha)

Private drops between two people. Codename sign-up, one-time invite links,
encrypted channels (notes, code, photos). Built for Netlify Functions + Blobs.

## Deploy (GitHub route)
1. Create a PRIVATE GitHub repo and upload everything in this folder
   (package.json and netlify.toml must be at the top level).
2. netlify.com: Add new site > Import an existing project > pick the repo.
3. Build command: leave empty. Publish directory: public. Functions: netlify/functions.
4. Deploy. Open the site, make two accounts in two different browsers
   (one normal, one private window) and test: Add spy > open link > Accept > leave drops.
5. Site settings > Change site name for a clean address (brush.netlify.app if free).

## Run locally
npm install -g netlify-cli && npm install && netlify dev

## How the privacy works
The passkey lives after the # in the invite link (never sent to the server) and
is saved in the browser. Drops are encrypted with AES-GCM before upload, so the
server stores ciphertext only. If both people lose the passkey, drops are gone.

## Defaults used
Drops live 7 days. Invites last 48 hours. Minimum age 16 (stated on sign-up).

## Not in v1
Recovery phrase, block/report, cells, cases, side quests, the Clan,
login rate limits beyond 5 tries, PWA install, account deletion.
