# Test plan — said, and done

Manual verification for the twenty-three packages on `main` at `823fc55`. Written
to be worked through by a person on a real screen, because **that is how every
live defect in this project has ever been found** — never by a passing test.

Fourteen issues are fixed and **deliberately left open** so you can close them
yourself. Each section below names the issue it verifies.

> **Read this first.** The most valuable thing you can do is §1 and §2 on **your
> own data**, not the demo seed. Your £222.94 was found in thirty seconds on your
> own accounts page, and the fixtures in this repository still avoid the shapes
> your data has.

---

## 0 · Setup

### Full stack (needed for anything touching Postgres, import/export, or the digest)

```bash
corepack enable && pnpm install
cp .env.example .env
make up                                    # postgres, redis, services
pnpm --filter @finance-planner/web dev     # web on :5173
```

### What "demo data" gives you

`load demo data` on an empty profile seeds **4 accounts and 1 household**. It
refuses (`409 demo_not_empty`) if you already own an account or are in a
household — so it cannot touch a real profile.

### A caution about `pnpm dev`

`main.tsx` runs `<StrictMode>`, so **in development every `useAsync` and every
refetch fires twice**. If you are eyeballing the network tab you are seeing
double the production traffic. Build and preview if the count matters:

```bash
pnpm --filter @finance-planner/web build && pnpm --filter @finance-planner/web preview
```

### Two-user scenarios

§4 and §9 need a second signed-in user. Use two browser **profiles** (or one
normal + one private window), not two tabs — the refresh cookie **rotates**, so
two contexts sharing one session will sign each other out. That is correct
behaviour, not a bug.

---

## 1 · The account headline · issue #45

**This is the one you reported. Do it on the account that produced £222.94.**

| Step              | Expect                                                      |
| ----------------- | ----------------------------------------------------------- |
| Open that account | The banner **no longer says "£222.94 short"**               |
| Read the sentence | It names money still arriving **and** the residue, in words |
| Check the residue | On your figures, **£176.55** — `234.64 − (11.70 + 46.39)`   |

The wording should be close to:

> £46.39 is still on its way. Even after it lands, £176.55 of what is recorded
> as saved here is not in the account — either it never moved in, or the saved
> figures below are too high.

**What matters is that the sentence is actionable.** Both clauses point at
something on the same screen: "the saved figures below" is the plan table's
SAVED column, and £120.00 + £114.64 should still add to £234.64 in front of you.

**A failure here looks like:** the number being clamped to zero, the banner
staying silent when there _is_ an unexplained gap, or a sentence that states the
gap without saying which of the two explanations it might be.

### 1a · An account that can cover itself

Find (or make) an account where arriving money covers the shortfall.

- [ ] **No banner at all.** The old rule was `reserved > balance`; it is now
      `reserved > balance + arriving`.

### 1b · A stale balance

Take an account whose balance check-in is **more than 10 days old** (the same
threshold the accounts page's "stale N d" chip uses).

- [ ] The banner fires but **leads with the age**, and explicitly says a balance
      that old is not evidence the money is gone.
- [ ] Check in a fresh balance → the sentence changes to the ordinary one.

### 1c · The projection chart, same page

This half was **not in your report** — it was found in a browser while fixing the
banner.

- [ ] The projected balance line is **not negative** on an account that is not
      overdrawn. It was pinned at **−£222.94 across all twelve months**.
- [ ] The y-axis has no negative region.

**Note what it does _not_ do:** it does not credit the £234.64 into the opening
balance. That would assert the account holds money the banner says it doesn't.
It declines to _spend_ what the balance can't account for, so £222.94 is now the
amount the projection refuses to move.

---

## 2 · The flow diagram · issue #43

**Use a household with a pot fed by an authored movement** — not a derived
transfer. Derived transfers always drew correctly; the authored case is where the
defect lived, and no fixture in the repo had one until this work.

- [ ] `/flow?household=…` draws a ribbon **account → pot**.
- [ ] There is **no `elsewhere` node** for a sending account that is on screen.
- [ ] Node totals balance: for each node, `income + in == spending + out + leftover`.
- [ ] The subhead's "N of N drawn" matches the chips.

### 2a · The same fix on the household plan page

`HouseholdSankey` was kept and now asks the same endpoint.

- [ ] Open the household **plan** page. Its chart draws the same ribbon.
- [ ] **The chart and the table beside it agree.** Previously the chart drew
      £500 arriving into a pot while the table printed LEFT OVER £0.00 for the
      same account on the same date. They are about 130px apart on screen.

### 2b · The two refusals

Both are correct behaviour, not bugs:

- [ ] A household with **more than 40 accounts** prints the server's own
      sentence and draws nothing. **Nothing is silently truncated** — all the
      account chips stay on screen so you can build a smaller picture by hand.
- [ ] A household whose accounts span **two currencies** prints
      "a diagram cannot span currencies: …". The household _plan_ page still
      works — only the diagram refuses.

---

## 3 · The contribution ledger · issues #46, #49

On an account page, under the plan table.

- [ ] Record a contribution against a goal → **it appears in the ledger**, with
      its amount and its month. Previously it vanished; `listContributions` was
      typed, tested and called from nowhere.
- [ ] Edit the amount → **the plan moves with it.** The "still needed" figure and
      the plan table's `✓` tick both follow.
- [ ] Delete a hand-recorded row → it goes, and the plan moves back.
- [ ] The list shows **earlier months too**, not just this one — a row corrected
      back to its true month must not vanish, which would read as a deletion.

### 3a · A row a confirmation wrote

Confirm a transfer that funds a goal, then look at the ledger.

- [ ] The row shows **where it came from** (a "from a confirmed transfer" badge).
- [ ] It offers **no edit and no remove control**, at 1280 **and** 390.
- [ ] Un-confirm the transfer → **the row goes with it.**

The API refuses `PATCH`/`DELETE` on such rows with `409 confirmation_generated`,
so a control here would be an action the API would reject.

### 3b · Privacy mode

- [ ] Turn on privacy mode. **Every figure in the ledger blurs**, including the
      summary sentence.
- [ ] The plan table's `✓ £nnn.nn` tick blurs too — it was the only unblurred
      figure on the whole account page.

---

## 4 · Confirmations · issues #47, #50, #48

### 4a · A past month · #50

You need a plan whose shape **differs between two months** — a payment that
started partway, or an amount that changed. If both months agree, this proves
nothing.

- [ ] Confirm a transfer for a **past** month.
- [ ] The amount booked is **that month's**, not today's.
- [ ] Confirming a **future** month is refused, with the same message closing a
      future month gives.

**Known limit, not introduced here:** a past month is re-derived from payment and
income definitions _as they stand today_, because the store keeps no history of
payment edits. Closing a month always had this limit; confirmations now share it.

### 4b · Who can un-confirm · #47 — **this is an intended loss**

Two users, an account shared with `edit`.

- [ ] User A confirms a movement.
- [ ] User B (a co-editor, but **not** the member on the confirmation) tries to
      un-confirm → **403**.
- [ ] User A can still un-confirm their own.
- [ ] On a **household** transfer, an owner/admin **can** still un-confirm
      somebody else's — that route keeps its own admin rule deliberately.

**This removes an ability co-editors have today. That is the point of the
change.** If it feels wrong in practice, that is worth knowing — but it is
working as decided, not broken.

### 4c · Atomicity · #48

Hard to trigger by hand — it is covered by a contract test that drives the
failure path against real Postgres. What you can check:

- [ ] Confirm a transfer funding **two or more** goals → all the contribution
      rows appear together, and the ledger total matches the confirmed amount.
- [ ] Un-confirm → **all** of them go. No half-standing state.

---

## 5 · Import / export · issues #51, #52

### 5a · Duplicate account names · #52 — **this is an intended loss**

- [ ] Make two accounts with the **same name** (e.g. two called "Savings").
- [ ] Export. **The export succeeds** — that file is an honest record of your
      data.
- [ ] Import it. **It is refused, naming the duplicate.**
- [ ] **Nothing is written** — check no accounts, projects or closes appeared.

The asymmetry is deliberate: you really can own two accounts with one name; what
that file is not is _restorable_.

### 5b · Confirmations survive a round trip · #51

- [ ] Confirm a transfer that generates contributions.
- [ ] Export → wipe → import.
- [ ] Un-confirm the restored confirmation → **the contribution rows go with
      it.** Previously they were orphaned.
- [ ] Try to delete a restored confirmation-generated row directly → **refused**,
      exactly as a natively-created one is.

### 5c · An old backup still restores

- [ ] Import an export file written **before** this work. It must still restore
      in full. The schema change is additive only.

---

## 6 · Auth rate limiting · issue #66

Needs the real auth service, not `inject()`.

- [ ] Four `POST /auth/register` in one minute → **three accepted, the fourth
      429**, with `x-ratelimit-limit: 3`, `x-ratelimit-remaining: 0` and
      `retry-after`.
- [ ] The 429 body is the service's normal envelope — `{"error":{"code":"rate_limited",…}}`,
      **not a 500**. That was a second bug that would have hidden this one.
- [ ] A malformed JSON body returns **400**, not 500.
- [ ] Normal back-to-back logins still work.

Now throttled: register 3/min, login 5/min, password/forgot 3/min,
password/reset 5/min, OIDC 20/min, refresh 20/min, TOTP 10/min,
`DELETE /auth/me` 3/min.

**Still unthrottled and worth an issue:** `/auth/verify-email`, which consumes a
guessable token.

---

## 7 · The daily digest · issue #54

- [ ] Point the mailer at something that fails once, then succeeds → the digest
      **is delivered on the retry, the same day**.
- [ ] A mailer that always fails → the pass runs twice and **does not send
      twice**.
- [ ] An **empty** digest still claims the day (no mail, and no second attempt).

**Accept this cost knowingly:** a send that _delivers and then throws_ now yields
**one duplicate email**. That is the at-least-once price of retryability. Today's
code can't duplicate because it never retried — it silently lost the day instead.

**Still open:** a process restart between failure and retry loses the day. The
retry lives in process memory. Closing that needs a releasable claim in the
store.

---

## 8 · Helm · issue #53

```bash
helm template fp deploy/helm/finance-planner | grep -A2 HorizontalPodAutoscaler | grep name:
helm template fp deploy/helm/finance-planner -f deploy/helm/finance-planner/values-prod.yaml | grep -A2 HorizontalPodAutoscaler | grep name:
```

- [ ] Both print **`fp-api`, `fp-calc`, `fp-web`** and **no `fp-auth`**.
- [ ] `fp-auth`'s Deployment now actually carries `replicas: 1` — previously **no
      Deployment in this chart rendered a replica count at all**, so all eight
      declared numbers were dead text.
- [ ] The PodDisruptionBudget says `maxUnavailable: 1`, not `minAvailable: 1`
      (which permitted zero disruptions and hung `kubectl drain` forever).
- [ ] Re-enable auth's autoscaling in `values.yaml` → **CI fails**. Revert.

---

## 9 · Names you may not see · decisions 36, 41, 42

Needs two users and an **assigned-but-unshared** account: assign an account to a
household without sharing it with the other member. The UI offers assign and
share as separate controls, so this is a configuration your own product invites.

- [ ] The member who **cannot** see that account opens the household flow → the
      diagram **draws**, with that node named **"other account"**, carrying its
      real amounts.
- [ ] Node totals still balance — the money is in the picture, only the name is
      not.
- [ ] The member who **can** see it sees it **by name**. This is the half that
      matters: the original complaint was an account you _could_ see showing as
      "other".
- [ ] The household plan page and the household accounts list also withhold that
      name.
- [ ] **The daily digest** for a reader who cannot see the far account says
      "another account", not its name. Email is the one surface where you cannot
      re-check the gate.

### 9a · Your own name

- [ ] A user whose money is pulled into a household they are **not** a member of
      sees **"you"** on their own ribbon and their own inflow sources — not
      "a household member".
- [ ] A different reader still sees the anonymised fallback.

---

## 10 · Error states, not empty states

Two fixes that only show up when something fails. Easiest with devtools request
blocking, or by stopping the api mid-session.

- [ ] Block `GET /api/accounts` and load the **Overview** → it says
      **"could not read your accounts."** It must **not** say "no accounts yet"
      or offer **"load demo data"**.
- [ ] Same on the **accounts page**.
- [ ] A genuinely **new** profile still gets the first-run screen, create button
      and demo button. This is the half that is easy to break.
- [ ] Block one account's plan on the **household plan page** → a strip names
      **which** account could not be read, and the other accounts still render
      their rows.

---

## 11 · What must NOT have moved

The regression surface. **Nothing in this work was about a lone user with one
account**, and every figure on that path must be identical to before.

- [ ] A solo account with one or two goals: the plan table, the leftover, the
      already-saved and the projection all read as they did.
- [ ] Recording a contribution for the **current** month still works, and for a
      **past** month still works — only future months are refused.
- [ ] Month close is unchanged. Its wording still says "Cannot close a future
      month".
- [ ] Back-dating a contribution is still allowed at both ends. Money genuinely
      can have been set aside in the past.

---

## 12 · The intended losses, collected

Four things a user could do before and cannot now. All deliberate; all worth
sanity-checking against how you actually use the app.

1. **A co-editor cannot un-confirm somebody else's movement** (#47).
2. **An import file with duplicate account names is refused** (#52).
3. **A household above 40 accounts, or spanning two currencies, gets no
   diagram** (#43) — it previously rendered via the client-side path.
4. **A contribution cannot be recorded for a month that has not started.**

On (4): this was not removing a working feature. Already-saved is cumulative and
unbounded, so a future-dated row counted **immediately** and inflated this
month's banner the moment it was written. The real loss is narrow — someone doing
month-end admin on the 31st who wants to pre-record the transfer they will make
on the 1st. If you want that properly, it needs a _scheduled_ contribution the
reader excludes until its month arrives, which is a feature rather than a
relaxation.

---

## 13 · Known open, by design

Not defects introduced here — found during the work and deliberately not taken.
Listed so you are not surprised, and so the next plan starts from them.

- **`plan.ts:354`** — `savedByPayment` takes no month, while the sibling call one
  line down in the same `Promise.all` does. **A plan asked for June still sums
  July's contributions into June's already-saved.** This is the _reader_ half of
  the bound just added at the writer. Closing it means putting a date on the
  store interface and both implementations.
- **`NewPaymentDrawer` / `NewIncomeDrawer`** — a failed accounts read renders
  "no editable accounts. create one first" inside a form whose purpose is to
  write.
- **`HouseholdDetailPage.tsx:599`** — `?? "unassigned"` is reachable **only**
  when a name lookup failed, never when the assignment is missing.
- **`/auth/verify-email`** is unthrottled and consumes a guessable token.
- **`values.yaml`** hardcodes service hostnames that resolve only if the release
  is named exactly `finance-planner`. CI renders as `fp`, so the manifest CI
  checks points at three hostnames that do not exist in that render.
- **A digest lost to a process restart** between failure and retry (§7).
- **Two authored movements** between the same pair of accounts, confirmed in the
  same month, collide on the export's confirmation key and come back untied.
  Safe — never a wrong tie — but real.

---

## What the automated suites already cover

So you can spend your time where they cannot. All green on `823fc55`:

|                                                               |                           |
| ------------------------------------------------------------- | ------------------------- |
| domain                                                        | 434                       |
| api                                                           | 234                       |
| web                                                           | 738                       |
| auth                                                          | 46                        |
| data (real Postgres, Testcontainers)                          | 8                         |
| e2e (signs in, walks six pages, fails on any 4xx/5xx fetched) | 3                         |
| `packages/domain` coverage                                    | 99.89 / 95.69 / 100 / 100 |

The e2e suite prints what it inspected — `inspected 107 responses, 63 of them
/api` — so a run that checked nothing is distinguishable from a run that passed.

**None of that tells you whether a sentence on screen means anything to a
person.** That is what §1 is for.
