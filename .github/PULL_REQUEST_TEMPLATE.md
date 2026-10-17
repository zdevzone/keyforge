**What this changes**

<!-- One or two sentences. Feature PRs target dev; promotions target main. -->

**Why**

<!-- The problem it solves. Link an issue if there is one. -->

**How it was verified**

<!-- Which of these you actually ran, and what happened: -->

- [ ] `vp run check`
- [ ] `vp run test` (SQLite)
- [ ] `vp run test` with `TEST_DATABASE_URL` set (Postgres)
- [ ] `vp run build:all`
- [ ] Scaffolded a project with `packages/create-keyforge` and used it

**Anything a reviewer should look at twice**

<!-- Behavior you were unsure about, a trade-off you made, a test you could not
write. Saying so is not a weakness in a PR; discovering it in review is worse. -->

- [ ] Target branch is correct; main promotions preserve history with a merge commit.
- [ ] Relevant docs and package versions are updated; no credentials or customer data included.
