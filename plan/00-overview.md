# Finance Planner — Project Overview

> **Status:** Discovery / planning
> **Last updated:** 2026-05-29
> **Owner:** b.ralton

## 1. Vision

A web application that helps people plan their savings toward upcoming payments.
You record your **income** and your **payments** (with their due dates and how
often they recur), and the app tells you:

1. **How much you need to set aside each month** for each payment in order to
   have the money ready by its target/due date.
2. **How much money you have left over** each month after all those
   contributions are accounted for.

The app is organised around **accounts**. Each account has its own incomes and
outgoings, and you can view a detailed breakdown per account as well as a
consolidated **overview across all accounts**.

## 2. Core concepts (glossary)

| Term | Meaning |
|------|---------|
| **Account** | A logical pot of money (e.g. "Joint Current Account", "Holiday Fund"). Owns incomes and outgoings. |
| **Income** | Money coming into an account, with an amount and a frequency. |
| **Payment (outgoing)** | Money leaving an account. Belongs to one of the payment categories below and has a target/due date. |
| **Required monthly contribution** | The amount the app calculates you should save this month toward a given payment to hit its target date. |
| **Leftover / surplus** | Income minus all committed contributions and direct outgoings for the period. |
| **Shortfall / deficit** | When committed contributions exceed available income; the unfunded amount. |
| **Household** | A group of users who share one or more accounts. |

## 3. Payment categories

The app supports four payment categories. The savings maths differs per
category (see `02-domain-model.md` and `03-calculation-engine.md`).

1. **Monthly recurring** — a fixed amount due every month (e.g. £45 phone bill).
2. **Yearly recurring** — a fixed amount due once a year on a given date
   (e.g. £320 car insurance due each March).
3. **Custom recurring** — recurs on a custom cadence (every *N* days / weeks /
   months / years), e.g. quarterly water bill every 3 months.
4. **Fixed-point payment** — a one-off payment due on a specific date
   (e.g. £1,200 holiday due 2026-08-01).

## 4. Key product decisions (from discovery)

These were confirmed with the product owner during the discovery questionnaire:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Auth / user model** | Multi-user with login **+ shared households** | Multiple people (e.g. partners) can share accounts. Drives the permissions model in `06-auth-and-households.md`. |
| **Service decomposition** | A few **coarse** services sharing Postgres | Pragmatic microservices: frontend, API/BFF, auth, calculation worker. Avoids premature fine-graining. |
| **Income-shortfall behaviour** | **Prioritise + show shortfall** | User ranks goals; app funds in priority order and flags the unfunded gap + at-risk target dates. |
| **Infrastructure target** | **Cloud-agnostic manifests + local dev** | Plain k8s / Helm runnable on any cluster; kind/minikube for local. |

## 5. Non-goals (initial release)

- Direct bank integration / Open Banking sync (candidate for a later phase).
- Multi-currency conversion (single display currency per account initially —
  see open questions).
- Investment / interest modelling beyond simple savings.
- Mobile native apps (responsive web only).

## 6. High-level technology choices

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | React + TypeScript (Vite) | See `05-frontend.md`. |
| Backend | TypeScript (Node) API service(s) | Shared language with frontend; see `04-backend-services.md`. |
| Calculation | Dedicated worker/service | Pure, deterministic engine; see `03-calculation-engine.md`. |
| Database | PostgreSQL | Single primary, per-service schemas. See `03b? -> 02-domain-model.md`. |
| Auth | OIDC / JWT sessions | See `06-auth-and-households.md`. |
| CI/CD | GitHub Actions | See `07-devops-cicd-kubernetes.md`. |
| Runtime | Kubernetes (cloud-agnostic) | Helm charts + kustomize overlays. |

> Backend framework (NestJS vs. Fastify vs. Express) and ORM (Prisma vs.
> Drizzle vs. Kysely) are proposed in `04-backend-services.md` and flagged in
> `09-open-questions.md` for final sign-off.

## 7. Plan document index

| File | Contents |
|------|----------|
| `00-overview.md` | This document — vision, decisions, glossary. |
| `01-architecture.md` | System architecture, services, data flow, repo layout. |
| `02-domain-model.md` | Entities, relationships, data model, Postgres schema. |
| `03-calculation-engine.md` | The savings maths: formulas, examples, shortfall logic. |
| `04-backend-services.md` | Service responsibilities, API design, endpoints. |
| `05-frontend.md` | React app structure, screens, state, components. |
| `06-auth-and-households.md` | Authentication, users, households, sharing, permissions. |
| `07-devops-cicd-kubernetes.md` | Docker, GitHub Actions, Helm, k8s, environments. |
| `08-roadmap.md` | Phased delivery plan with milestones and acceptance criteria. |
| `09-open-questions.md` | Outstanding decisions to resolve in later discovery. |

## 8. How to read these plans

Start here, then read `01-architecture.md` for the shape of the system and
`02-domain-model.md` + `03-calculation-engine.md` for the heart of the product.
The remaining documents detail each slice. `08-roadmap.md` sequences the work
into shippable phases.
