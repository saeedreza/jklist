# Roadmap

Rough order within each part. Nothing here is promised.

## Search

- [ ] Location as coordinates: agents send rough lat/lng, search by radius; retire `data/places.json`
- [ ] Hybrid retrieval: embeddings beside FTS5, merged with reciprocal rank fusion
- [ ] Weight rare terms higher, so "piano lessons" stops matching "Portuguese lessons"
- [ ] Larger eval set: graded relevance, more languages, queries that should find nothing
- [ ] Agent evals: Claude, ChatGPT, Codex and Gemini doing real tasks on a seeded board

## Posts

- [ ] Categories with typed fields (price, dates, bedrooms) and filters on them
- [ ] Saved searches: new matching posts emailed to whoever saved the search

## Conversations

- [ ] Report a conversation, with its messages, to admins

## Platform

- [ ] Key expiry and read-only keys
- [ ] Report weighting that holds up against batches of new accounts
- [ ] Split `server.js` into modules once one file stops being readable
