# Keyforge

<!-- impeccable:product-schema 1 -->

## Platform
web

## Product Purpose
An MIT-licensed, independently self-hostable licensing server for a company's
applications, products and services. A future paid hosted edition reuses the core.

## Users
Admins manage products, license policy, keys and operations. Support operators
handle requests and transfers. Both maintain their own accounts.

## Stack
Fastify, TypeScript, Better Auth, SQLite/Postgres; React, TanStack Query,
Tailwind and generated shadcn components.

## Constraints
No hosted account required. Signing, authentication and encryption keys remain outside GUI-managed policy. Backup-provider credentials are editable by admins and encrypted in the database.
The public `/welcome` page presents the MIT source download and links to this
deployment's operator sign-in. Optional Windows, Linux and macOS signals help recognize reported
machine groups; they do not prove physical-device counts or replace installation identity.
Installation identity is authenticated; client usage/clock integrity remains
the consuming application's responsibility. New device API has no legacy-client
compatibility. Preserve records through database migrations.

## Brand Commitments
Use the user-selected Polaris theme from shadcnblocks, authored by tweakcn, for
the console: locally hosted Google Sans Flex, cool neutral light/dark surfaces,
teal primary actions, amber secondary accents and square base corners, as recorded
in ui/DESIGN.md. Prioritize clear operations, accessible controls, visible
permissions and complete responsive workflows. This supersedes the earlier
Figma/Inter/blue console direction.
