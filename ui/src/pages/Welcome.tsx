import { ArrowDownToLine, ArrowRight, Check, Code2, GitBranch, KeyRound, Menu } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { ThemeControl, useTheme } from "../components/ThemeControl";

const source = "https://github.com/zdevzone/keyforge";
const navigation = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Docs", href: "/docs" },
  { label: "GitHub", href: source },
];
const steps = [
  ["Define a plan", "Set license terms, entitlements, installation limits and a price in ETB."],
  [
    "Issue to a customer",
    "Choose a plan. KeyForge records the sale as unpaid, or records payment when you issue. Customers can request a key before installation.",
  ],
  [
    "Activate online",
    "Your app registers its installation identity and activates the key. KeyForge checks the license and available seats, then returns signed authorization.",
  ],
  [
    "Continue within policy",
    "The SDK verifies cached authorization offline until its signed deadline. Reconnect to refresh; revocation takes effect when checked online or authorization expires.",
  ],
];
const questions = [
  [
    "Can I download and host KeyForge myself?",
    "Yes. KeyForge is MIT-licensed source code. Download the source, configure your signing keys and database, and deploy it to infrastructure you control. Hosting and maintaining your deployment are your responsibility.",
  ],
  [
    "Does a customer need internet access?",
    "Internet is required to activate a key, start an authorized trial and refresh authorization. Previously authorized usage can continue offline only within the signed server policy. A new key cannot be activated offline.",
  ],
  [
    "Does KeyForge collect payments?",
    "No payment gateway is included. KeyForge records sales and manual payments, outstanding balances and refunds in ETB. Historical sale amounts stay unchanged when a plan price changes.",
  ],
  [
    "Does a machine group prove how many physical devices I have?",
    "No. Optional hashed Windows, Linux and macOS signals help recognize reported machine groups. They can be missing, changed or cloned. Activation limits count installation identities; matching hardware never automatically transfers or releases a seat.",
  ],
  [
    "How do I connect my application?",
    "Use the framework-independent TypeScript SDK for registration, activation, refresh and signed offline checks. Supply secure storage appropriate to your app. Optional Node-only adapters collect Windows, Linux and macOS device signals. HTTP documentation and an OpenAPI contract support integrations in other languages.",
  ],
  [
    "Is this a hosted SaaS with public sign-up?",
    "This release is software for self-hosting. The Sign in link opens this deployment’s operator console; accounts are provisioned by its administrator. Multi-tenant SaaS and public sign-up are future work.",
  ],
];

/** Adapted from shadcnblocks hero1: copy and actions beside a real product preview. */
export default function Welcome() {
  const theme = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    document.title = "KeyForge — Self-hosted software licensing";
  }, []);
  return (
    <div className="welcome-page">
      <a className="welcome-skip" href="#welcome-main">
        Skip to content
      </a>
      <header className="welcome-header">
        <div className="welcome-container welcome-header-inner">
          <Link className="welcome-brand" to="/welcome" aria-label="KeyForge home">
            <KeyRound aria-hidden="true" />
            <span>KeyForge</span>
          </Link>
          <nav className="welcome-desktop-nav" aria-label="Main navigation">
            {navigation.map((item) => (
              <a key={item.label} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <ThemeControl />
            <Button variant="outline" asChild>
              <Link to="/login">
                Sign in
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  className="welcome-menu-button"
                  variant="ghost"
                  size="icon"
                  aria-label="Open navigation"
                >
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>KeyForge</SheetTitle>
                  <SheetDescription>Software licensing on your infrastructure.</SheetDescription>
                </SheetHeader>
                <nav className="flex flex-col gap-5 p-6" aria-label="Mobile navigation">
                  {navigation.map((item) => (
                    <a key={item.label} href={item.href} onClick={() => setMenuOpen(false)}>
                      {item.label}
                    </a>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main id="welcome-main" tabIndex={-1}>
        <section className="welcome-container welcome-hero" aria-labelledby="welcome-title">
          <div className="welcome-intro">
            <h1 id="welcome-title">
              License your software.
              <br />
              <span>Host it yourself.</span>
            </h1>
            <p>
              Issue license keys, define what they unlock, and keep control of your software.
              KeyForge brings licensing operations to your own infrastructure.
            </p>
            <div className="welcome-actions">
              <Button asChild size="lg">
                <a href={source + "/archive/refs/heads/main.zip"}>
                  <ArrowDownToLine data-icon="inline-start" aria-hidden="true" />
                  Download source
                </a>
              </Button>
              <Button variant="outline" asChild size="lg">
                <a href="/docs/deploy">
                  Read the deployment guide
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </a>
              </Button>
            </div>
            <p className="welcome-license-note">
              MIT licensed. Self-hosted. Your keys and data stay with you.
            </p>
          </div>
          <figure className="welcome-preview">
            <div className="welcome-preview-bar">
              <span>KeyForge console</span>
              <span>Demo workspace</span>
            </div>
            <img
              src={`/welcome-console-${theme}.png`}
              width="1200"
              height="720"
              alt="KeyForge Plans screen with demo plan terms and pricing. No customer data is shown."
              fetchPriority="high"
            />
            <figcaption>One place for products, plans and the licenses you issue.</figcaption>
          </figure>
        </section>

        <section id="features" className="welcome-features" aria-labelledby="features-title">
          <div className="welcome-container welcome-feature-layout">
            <div>
              <h2 id="features-title">
                Your licensing policy.
                <br />
                Your infrastructure.
              </h2>
              <p>From the first key to the next renewal, keep the operational details connected.</p>
            </div>
            <dl className="welcome-feature-list">
              <div>
                <dt>Plans that travel with the license</dt>
                <dd>
                  Entitlements, expiry and installation limits are captured at issuance. Signed
                  Ed25519 authorization lets your app check permitted offline use.
                </dd>
              </div>
              <div>
                <dt>A clear view of your customers</dt>
                <dd>
                  See installations and activation history, manage support conversations, and
                  deliver licenses through private request links or registered apps.
                </dd>
              </div>
              <div>
                <dt>Sales and payments, kept distinct</dt>
                <dd>
                  Record manual ETB payments and refunds. Report sales value, received payments and
                  outstanding balances without a payment gateway.
                </dd>
              </div>
              <div>
                <dt>Tools for the people operating it</dt>
                <dd>
                  Admin and support roles, in-app notifications, audit history and encrypted backups
                  help you run your own service.
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section
          id="how-it-works"
          className="welcome-container welcome-section"
          aria-labelledby="workflow-title"
        >
          <div className="welcome-section-heading">
            <h2 id="workflow-title">From a plan to a running app.</h2>
            <p>
              KeyForge runs the licensing service. Your app decides where its licensed features
              begin.
            </p>
          </div>
          <ol className="welcome-steps">
            {steps.map(([title, description], index) => (
              <li key={title}>
                <span className="welcome-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="welcome-integration" aria-labelledby="integration-title">
          <div className="welcome-container welcome-integration-layout">
            <div>
              <h2 id="integration-title">
                A server you own.
                <br />
                An SDK your app can use.
              </h2>
              <p>
                Deploy the Node.js service with SQLite or PostgreSQL. Keep private signing keys on
                the server and pin public verification keys in your app.
              </p>
              <ul className="welcome-checks">
                <li>
                  <Check aria-hidden="true" />
                  TypeScript SDK and a Node reference integration
                </li>
                <li>
                  <Check aria-hidden="true" />
                  Explicit secure storage adapters
                </li>
                <li>
                  <Check aria-hidden="true" />
                  HTTP API, OpenAPI and an AI integration skill
                </li>
              </ul>
              <a className="welcome-text-link" href="/docs/dependent-app-integration">
                Explore the integration guide
                <ArrowRight aria-hidden="true" />
              </a>
            </div>
            <div className="welcome-code">
              <div>
                <Code2 aria-hidden="true" />
                <span>Inside your application</span>
              </div>
              <pre>
                <code>{`const client = new KeyForgeClient({\n  serverUrl,\n  productId,\n  publicKeys, // pinned verification keys\n  storage,    // your secure storage adapter\n});\n\nawait client.activate(licenseKey);\nconst access = await client.getAuthorization();\n\nif (access.state === "licensed") {\n  // Check entitlements at the protected action.\n}`}</code>
              </pre>
              <p>
                Activation needs a connection. Offline authorization stays bounded by signed policy.
              </p>
            </div>
          </div>
        </section>

        <section
          className="welcome-container welcome-faq welcome-section"
          aria-labelledby="faq-title"
        >
          <div>
            <h2 id="faq-title">Before you deploy.</h2>
            <p>The practical details, without the fine print.</p>
          </div>
          <Accordion type="single" collapsible>
            {questions.map(([question, answer], index) => (
              <AccordionItem key={question} value={String(index)}>
                <AccordionTrigger>{question}</AccordionTrigger>
                <AccordionContent>{answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      </main>
      <footer className="welcome-footer">
        <div className="welcome-container">
          <div>
            <Link className="welcome-brand" to="/welcome">
              <KeyRound aria-hidden="true" />
              KeyForge
            </Link>
            <p>Software licensing. On your terms.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href={source + "/blob/main/LICENSE"}>MIT license</a>
            <a href="/docs">Documentation</a>
            <a href={source}>
              <GitBranch aria-hidden="true" />
              Source on GitHub
            </a>
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
