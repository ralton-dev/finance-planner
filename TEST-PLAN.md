# Test plan — said, and done

Manual verification for the twenty-three packages on `main` at `823fc55`. Written
to be worked through by a person on a real screen, because **that is how every
live defect in this project has ever been found** — never by a passing test.

Fourteen issues are fixed and **deliberately left open** so you can close them
yourself. Each section below names the issue it verifies.

> **Read this first.** The most valuable thing you can do is still §1 and §2 on
> **your own data**. Your £222.94 was found in thirty seconds on your own
> accounts page, and no fixture ever finds a defect the way a real estate does.
>
> But your own data cannot run half of this plan — §5b wipes a profile, §6
> deliberately exhausts the auth rate limits, §9 needs an account assigned and
> deliberately not shared. So §0 now hands you **ten disposable logins** that
> carry every shape the sections below name, `reality@fp.test`'s Holiday Fund
> included, which is your £222.94 rebuilt figure for figure.

---

## 0 · Setup

### The stack, and the URL to use

```bash
corepack enable && pnpm install
cp .env.example .env                       # if you have not already
make up                                    # postgres, redis, api, auth, calc, web
```

**Test against `http://localhost:8080`** — nginx serving the production bundle
and proxying `/api` to the gateway. Not `pnpm dev`; see the caution below.

### The fixtures

This plan used to ask you to work on shapes no fixture in this repository had,
which is why so much of it said "find (or make)". They exist now, planted
through the real HTTP API — never through SQL, because half of them exist to
exercise a confirm handler, a guard or a refusal that only runs on the route:

```bash
./apps/api/node_modules/.bin/tsx deploy/local/seed-test-fixtures.mts
```

**The first run takes about five minutes and will look stalled.** It is not:
that is §6's own register limit throttling it to three accounts a minute, and
every wait is announced. A second run resumes the sessions it cached and starts
in seconds.

Re-run it whenever you have wrecked something. Each fixture login is torn down
and rebuilt from nothing, and **nothing outside those ten logins is touched** —
your own accounts, and the dev data already in this database, are not read let
alone written. It prints the figures it actually planted and fails loudly if any
of them came out wrong, so a fixture that has drifted tells you rather than
letting the app take the blame.

### The logins

**One password for every one of them: `TestPlan!2026`.**

| Login                | Serves                           | What it carries                                                                                                       |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `reality@fp.test`    | §1, §1a, §1b, §1c, §9a, §11      | **Holiday Fund** (§1), Covered Pot (§1a), Stale Pot (§1b), Rent Pot (§9a), and the Current Account that feeds them    |
| `flow@fp.test`       | §2, §2a                          | **Flow House** — a pot fed by an **authored** movement out of Flow Current, not a derived transfer                    |
| `flowmate@fp.test`   | §2 (the second member)           | Mate Current, inside Flow House                                                                                       |
| `bighouse@fp.test`   | §2b (first refusal)              | **Forty One House** — 41 accounts, one over `MAX_FLOW_ACCOUNTS`                                                       |
| `currencies@fp.test` | §2b (second refusal)             | **Two Currency House** — Sterling Current in GBP, Euro Savings in EUR                                                 |
| `ledger@fp.test`     | §3, §3a, §3b, §4a, §4b, §4c, §9  | **Ledger House** — Ledger Goals (two goals, one confirmable movement), Ledger Private (assigned, never shared), a pot |
| `ledgermate@fp.test` | §4b, §9 (the reader who may not) | Co-editor on Ledger Current and Ledger Goals; **cannot see** Ledger Private                                           |
| `dupe@fp.test`       | §5a                              | Two accounts both called **Savings**                                                                                  |
| `roundtrip@fp.test`  | §5b                              | **Disposable.** RT Goals, two goals, one confirmable movement. Export, wipe and re-import it as roughly as you like   |
| `newbie@fp.test`     | §10                              | Nothing at all — the first-run screen is the fixture                                                                  |

§6 (rate limits), §8 (helm) and §10's blocked-request half need no login: curl,
`helm template` and devtools drive those.

### Two switches

**`ENABLE_DEMO_SEED=true` is already set in `.env`**, and the api container has
been recreated to pick it up — `GET /api/meta` now answers
`{"demoSeedEnabled":true}`. Without it `POST /api/demo/seed` 404s and §10's
**load demo data** button is not rendered at all, so §10 would pass for the wrong
reason.

> **`make up` does not read this `.env`.** Compose takes its project directory
> from the compose file, so `-f deploy/local/docker-compose.yml` looks for
> `deploy/local/.env` and finds nothing — every switch in `.env.example` is
> silently ignored, `JWT_SIGNING_KEY` included. Name the file explicitly:
>
> ```bash
> docker compose --env-file .env -f deploy/local/docker-compose.yml up -d api
> ```

**`NOTIFY_ENABLED` is deliberately still `false`** — §7 is the one section left
switched off, because turning the digest on silently would start a sender
against the fixture users on a fifteen-minute tick. For §7, set in `.env`:

```
NOTIFY_ENABLED=true
NOTIFY_HOUR=0          # else nothing sends until 08:00 local
SMTP_URL=smtp://127.0.0.1:2525   # a port with nothing on it = a mailer that always fails
```

then recreate api with the `--env-file` form above. `SMTP_URL` unset is the
**log** mailer, which never fails and so cannot show you a retry. Point it at a
dead port for the always-fails case; run something on 2525 that refuses once and
then accepts for the fails-once case. Opt a user in with
`PATCH /api/auth/me {"notifyEmail":true}`
— `reality@fp.test` has upcoming payments and is the one with something to say.

### What "demo data" gives you

`load demo data` on an empty profile seeds **4 accounts and 1 household**. It
refuses (`409 demo_not_empty`) if you already own an account or are in a
household — so it cannot touch a real profile. `newbie@fp.test` is the empty one.

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

**This is the one you reported. Do it on the account that produced £222.94** —
and if that account is not to hand, sign in as **`reality@fp.test`** and open
**Holiday Fund**, which is your arithmetic rebuilt from nothing: £11.70 observed
in the account today, £234.64 recorded as saved across two payments, £46.39
arriving from a movement out of the current account. `reserved − balance` is
`234.64 − 11.70` = **£222.94**, so the sentence this section retired is exactly
the sentence the old code would print here.

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

`reality@fp.test` → **Covered Pot**. The same £11.70 and the same £234.64
recorded as saved, but **£300.00 arriving** instead of £46.39.

- [x] **No banner at all.** The old rule was `reserved > balance`; it is now
      `reserved > balance + arriving`.

### 1b · A stale balance

`reality@fp.test` → **Stale Pot**, whose balance check-in is **20 days old** —
past the 10-day threshold the accounts page's "stale N d" chip uses. £50.00
observed then, £200.00 recorded as saved, nothing arriving.

- [x] The banner fires but **leads with the age**, and explicitly says a balance
      that old is not evidence the money is gone.
- [x] Check in a fresh balance → the sentence changes to the ordinary one.

### 1c · The projection chart, same page

This half was **not in your report** — it was found in a browser while fixing the
banner.

- [x] The projected balance line is **not negative** on an account that is not
      overdrawn. It was pinned at **−£222.94 across all twelve months**.
- [x] The y-axis has no negative region.

**Note what it does _not_ do:** it does not credit the £234.64 into the opening
balance. That would assert the account holds money the banner says it doesn't.
It declines to _spend_ what the balance can't account for, so £222.94 is now the
amount the projection refuses to move.

---

## 2 · The flow diagram · issue #43

**Use a household with a pot fed by an authored movement** — not a derived
transfer. Derived transfers always drew correctly; the authored case is where the
defect lived, and no fixture in the repo had one until this work.

`flow@fp.test` → **Flow House**. Flow Pot draws **three** ribbons: two derived
transfers of £215.00, one from each member, funding £430.00 of bills; and the
**authored £500.00 movement** out of Flow Current, which is the one this section
is about. Having both on the same picture is the point — the authored one is the
one that used to vanish into `elsewhere`.

- [x] `/flow?household=…` draws a ribbon **account → pot**.
- [x] There is **no `elsewhere` node** for a sending account that is on screen.
- [x] Node totals balance: for each node, `income + in == spending + out + leftover`.
- [x] The subhead's "N of N drawn" matches the chips.

### 2a · The same fix on the household plan page

`HouseholdSankey` was kept and now asks the same endpoint.

- [x] Open the household **plan** page. Its chart draws the same ribbon.
- [x] **The chart and the table beside it agree.** Previously the chart drew
      £500 arriving into a pot while the table printed LEFT OVER £0.00 for the
      same account on the same date. They are about 130px apart on screen.

### 2b · The two refusals

Both are correct behaviour, not bugs. One login each, because **a user belongs
to exactly one household** — `bighouse@fp.test` for the first,
`currencies@fp.test` for the second.

- [x] A household with **more than 40 accounts** prints the server's own
      sentence and draws nothing. **Nothing is silently truncated** — all the
      account chips stay on screen so you can build a smaller picture by hand.
- [ ] A household whose accounts span **two currencies** prints
      "a diagram cannot span currencies: …". The household _plan_ page still
      works — only the diagram refuses. - **FAILURE** - Diagram drawn for only 1 currency - other account doesnt even show in house despite being added. might as well not be in the house, but there are no warnings or indications that it isnt going to work.

---

## 3 · The contribution ledger · issues #46, #49

On an account page, under the plan table. `ledger@fp.test` → **Ledger Goals**,
which carries two goals and **one contribution already recorded two months
back**, so the last bullet here has something to fail on.

- [x] Record a contribution against a goal → **it appears in the ledger**, with
      its amount and its month. Previously it vanished; `listContributions` was
      typed, tested and called from nowhere.
- [x] Edit the amount → **the plan moves with it.** The "still needed" figure and
      the plan table's `✓` tick both follow.
- [x] Delete a hand-recorded row → it goes, and the plan moves back.
- [x] The list shows **earlier months too**, not just this one — a row corrected
      back to its true month must not vanish, which would read as a deletion.

### 3a · A row a confirmation wrote

Confirm a transfer that funds a goal, then look at the ledger. The **Goals
sweep** movement into Ledger Goals is the one — £300.00 a month out of Ledger
Current, and it funds **both** goals, which is also §4c's shape. Confirm it from
the checklist row, or `POST /api/inflows/{id}/confirm`.

- [x] The row shows **where it came from** (a "from a confirmed transfer" badge).
- [x] It offers **no edit and no remove control**, at 1280 **and** 390.
- [x] Un-confirm the transfer → **the row goes with it.**

The API refuses `PATCH`/`DELETE` on such rows with `409 confirmation_generated`,
so a control here would be an action the API would reject.

**NOTES** I assumed this was not talking about the manual entry created - and was instead talking about confirming the derived transfer, as manual entries do not add rows to the recorded.

### 3b · Privacy mode

- [x] Turn on privacy mode. **Every figure in the ledger blurs**, including the
      summary sentence.
- [x] The plan table's `✓ £nnn.nn` tick blurs too — it was the only unblurred
      figure on the whole account page.

---

## 4 · Confirmations · issues #47, #50, #48

### 4a · A past month · #50

You need a plan whose shape **differs between two months** — a payment that
started partway, or an amount that changed. If both months agree, this proves
nothing.

`ledger@fp.test` → **Ledger Goals** → **Christmas fund**, a `fixed_point` goal
due **31 December**. The divisor is the whole months left, so every month wants
a different figure: at the time of writing last month asked **£110.00** and this
month asks **£137.50**. The seeding script asserts the two disagree and prints
both, so if the calendar has moved on you have the current pair rather than
these.

- [x] Confirm a transfer for a **past** month.
- [x] The amount booked is **that month's**, not today's.
- [x] Confirming a **future** month is refused, with the same message closing a
      future month gives.

**Known limit, not introduced here:** a past month is re-derived from payment and
income definitions _as they stand today_, because the store keeps no history of
payment edits. Closing a month always had this limit; confirmations now share it.

### 4b · Who can un-confirm · #47 — **this is an intended loss**

Two users, an account shared with `edit`. **`ledger@fp.test` is A,
`ledgermate@fp.test` is B**: Ledger Current and Ledger Goals are both shared into
Ledger House with `edit`, so B is a genuine co-editor of the accounts the
movement runs between. The household transfer for the last bullet is the one
into **Ledger House Pot**, which both members fund.

- [x] User A confirms a movement.
- [x] User B (a co-editor, but **not** the member on the confirmation) tries to
      un-confirm → **403**.
- [x] User A can still un-confirm their own.
- [ ] On a **household** transfer, an owner/admin **can** still un-confirm
      somebody else's — that route keeps its own admin rule deliberately. - **FAIL** this isnt working, even as an admin I cannot confirm and undo someone elses transfer in a house pot.

**This removes an ability co-editors have today. That is the point of the
change.** If it feels wrong in practice, that is worth knowing — but it is
working as decided, not broken.

### 4c · Atomicity · #48

Hard to trigger by hand — it is covered by a contract test that drives the
failure path against real Postgres. What you can check:

- [x] Confirm a transfer funding **two or more** goals → all the contribution
      rows appear together, and the ledger total matches the confirmed amount.
- [x] Un-confirm → **all** of them go. No half-standing state.

---

## 5 · Import / export · issues #51, #52

### 5a · Duplicate account names · #52 — **this is an intended loss**

`dupe@fp.test`, which already owns two accounts called **Savings**.

- [x] Make two accounts with the **same name** (e.g. two called "Savings").
- [x] Export. **The export succeeds** — that file is an honest record of your
      data.
- [ ] Import it. **It is refused, naming the duplicate.** - **FAIL** It rejected the import but gave a weird error "that file doesn't look like a finance-planner export"
- [ ] **Nothing is written** — check no accounts, projects or closes appeared.

The asymmetry is deliberate: you really can own two accounts with one name; what
that file is not is _restorable_.

### 5b · Confirmations survive a round trip · #51

**`roundtrip@fp.test` exists to be destroyed.** RT Goals holds two goals fed by
one confirmable movement out of RT Current; wipe the login as roughly as you
like, because `deploy/local/seed-test-fixtures.mts` rebuilds it in seconds.
Nothing else in this database depends on it.

- [x] Confirm a transfer that generates contributions.
- [x] Export → wipe → import.
- [x] Un-confirm the restored confirmation → **the contribution rows go with
      it.** Previously they were orphaned.
- [x] Try to delete a restored confirmation-generated row directly → **refused**,
      exactly as a natively-created one is.

### 5c · An old backup still restores

- [x] Import an export file written **before** this work. It must still restore
      in full. The schema change is additive only.

**No fixture can supply this one** — it needs a file this codebase can no longer
write. If you have an export from before the confirmation work, use it; if not,
this bullet cannot be run, and saying so is better than substituting a file that
proves nothing.

<!-- ---

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
guessable token. -->

NO test. needs to go live for this to check with cloudflare.
---

<!-- ## 7 · The daily digest · issue #54

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
store. -->

Mailer not in use right now. we will leave this test
---

<!-- ## 8 · Helm · issue #53

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
- [ ] Re-enable auth's autoscaling in `values.yaml` → **CI fails**. Revert. -->

not fucking with helm.

---

## 9 · Names you may not see · decisions 36, 41, 42

Needs two users and an **assigned-but-unshared** account: assign an account to a
household without sharing it with the other member. The UI offers assign and
share as separate controls, so this is a configuration your own product invites.

**`ledger@fp.test` can see it, `ledgermate@fp.test` cannot.** The account is
**Ledger Private** — on Ledger House's roster, never shared with the household,
carrying a £120.00 subscription and a £200.00 movement in from Ledger Current.
The seeding script checks both halves over the API: the mate's roster row comes
back with no `accountName` at all, and the owner's comes back with one.

- [x] The member who **cannot** see that account opens the household flow → the
      diagram **draws**, with that node named **"other account"**, carrying its
      real amounts.
- [x] Node totals still balance — the money is in the picture, only the name is
      not.
- [x] The member who **can** see it sees it **by name**. This is the half that
      matters: the original complaint was an account you _could_ see showing as
      "other".
- [x] The household plan page and the household accounts list also withhold that
      name.

> **Watch what else the household plan page does**, because a browser found it
> while these fixtures were being checked. The page fetches a plan per rostered
> account, and `GET /api/accounts/{Ledger Private}/plan` answers **404** to the
> mate — correctly, since 404 is what hides existence. The page reads that as a
> failed read and prints _"could not read the plan for account — anything it was
> owed is missing from the checklist below"_, **with no account name in it**,
> because the name is the very thing being withheld. So a working access
> boundary is rendered as an error, in a strip whose whole job (§10) is to name
> which account it could not read. Verified on `ledgermate@fp.test`.

### 9a · Your own name

<!--
- [ ] A user whose money is pulled into a household they are **not** a member of
      sees **"you"** on their own ribbon and their own inflow sources — not
      "a household member".
- [ ] A different reader still sees the anonymised fallback.

**Neither bullet has a fixture, and the reason is worth knowing.** `"you"` is a
_fallback_: `derivedTransferItems` reads `displayName ?? (sender is me ? "you" :
"a household member")`, so it only appears when the **server withheld the name**
— which decision 42 makes it do only for a sender no household in the scope
rosters. Every arrangement these fixtures can reach through the API has the
server naming the sender properly.

`reality@fp.test` → **Rent Pot** gets you the _shape_: a pot with a £400.00 rent
bill and no income, fed by a transfer the pass derives out of Current Account.
It reads "£400.00 arriving from Reality Ben this month" — the reader's own name
where the design wants "you", which is worth a look in its own right, but it is
not the withheld case.

To reach the real one you need an account **assigned to a household its owner is
not a member of**, and the guards make that unreachable by construction: sharing
needs membership, and assigning needs access that only sharing grants. The one
door left is to assign first and remove the member afterwards —
`DELETE /auth/households/:id/members/:userId` drops the membership and leaves the
assignment standing. **Untested here**, and it would take `ledgermate@fp.test`
out of Ledger House, so re-seed afterwards. -->

not sure what the fucking point of this was. its not reachable at all.
---

## 10 · Error states, not empty states

Two fixes that only show up when something fails. Easiest with devtools request
blocking, or by stopping the api mid-session.

- [x] Block `GET /api/accounts` and load the **Overview** → it says
      **"could not read your accounts."** It must **not** say "no accounts yet"
      or offer **"load demo data"**.
- [x] Same on the **accounts page**.
- [x] A genuinely **new** profile still gets the first-run screen, create button
      and demo button. This is the half that is easy to break. `newbie@fp.test`
      owns nothing at all, and `ENABLE_DEMO_SEED` is on, so the demo button is
      rendered — without it this bullet passes for the wrong reason.
- [x] Block one account's plan on the **household plan page** → a strip names
      **which** account could not be read, and the other accounts still render
      their rows.

---

## 11 · What must NOT have moved

The regression surface. **Nothing in this work was about a lone user with one
account**, and every figure on that path must be identical to before.

- [x] A solo account with one or two goals: the plan table, the leftover, the
      already-saved and the projection all read as they did. `reality@fp.test` →
      **Holiday Fund** is exactly that account, and it is in no household.
- [x] Recording a contribution for the **current** month still works, and for a
      **past** month still works — only future months are refused.
- [x] Month close is unchanged. Its wording still says "Cannot close a future
      month".
- [x] Back-dating a contribution is still allowed at both ends. Money genuinely
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

### Two more, found while building the fixtures

Neither was known when the sections above were written. Both are in the seeding
script's comments as well, because it has to work around them.

- **A `fixed_point` payment paced by `fixedMonthlyMinor` alone is a 500.**
  `createPaymentBody` says such a payment needs "a dueDate **or**
  fixedMonthlyMinor", and the engine agrees — `contributionCapMinor` returns the
  cap and `required = min(cap, remaining)`, so no date is needed to pace it. But
  `db/migrations/0001_init.sql:112` carries
  `CHECK (category <> 'fixed_point' OR due_date IS NOT NULL)`. The route accepts
  the body, validates it, and then the insert violates the constraint: the caller
  gets **500 `internal`** for a request the contract documents as valid. The
  in-memory store has no such check, which is why every suite is green. Either
  the migration should be relaxed or the contract should stop promising it.
- **`allocatedInflowMinor` counts an authored movement and a derived transfer
  into the same pot as separate money.** It is `transferIn + movementIn`, and the
  pass transports a pot's expenses (decision 9) whether or not somebody has
  already authored a sweep into it. A pot with £46.39 of bills and an authored
  £46.39 sweep therefore reports **£92.78 arriving** — and that is the figure §1's
  banner subtracts and the ARRIVING tile prints. It may be defensible (a standing
  order is not the bills' funding), but nothing on screen says so, and it is why
  each §1 pot in the fixtures has an income of its own.

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
