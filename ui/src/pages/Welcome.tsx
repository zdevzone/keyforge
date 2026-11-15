import {
  ArrowRight,
  Check,
  Code2,
  Database,
  GitBranch,
  KeyRound,
  ListChecks,
  Menu,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

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
  { label: "Capabilities", href: "#capabilities" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Integrate", href: "#integrate" },
  { label: "Docs", href: "/docs" },
];
const capabilities = [
  {
    icon: KeyRound,
    title: "Issue licenses",
    description: "Set plan terms, create keys and deliver them to customers.",
  },
  {
    icon: ShieldCheck,
    title: "Authorize offline",
    description: "Signed grants let apps verify access until the policy deadline.",
  },
  {
    icon: Database,
    title: "Run your service",
    description: "Use SQLite or PostgreSQL on infrastructure you control.",
  },
];
const steps = [
  ["Define a plan", "Entitlements, expiry and activation limits."],
  ["Issue a key", "Create a license or accept a private request."],
  ["Activate online", "Your app receives signed authorization."],
  ["Check access", "Verify the grant offline until its deadline."],
];
const boundaries = [
  ["Self-hosted", "Your team runs the service and manages its data."],
  ["Online activation", "New activations and refreshes need internet access."],
  ["Manual payments", "Record ETB sales and payments. No gateway is included."],
];

/** Public landing page adapted from Shadcnblocks Landing Page 20, Hero 1 and Feature 18. */
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
          <div className="welcome-header-actions">
            <ThemeControl />
            <Button className="welcome-sign-in" variant="outline" asChild>
              <Link to="/login">Sign in</Link>
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
                <nav className="welcome-mobile-nav" aria-label="Mobile navigation">
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
            <p className="welcome-eyebrow">Open-source licensing for software teams</p>
            <h1 id="welcome-title">
              License your software.
              <span>Host it yourself.</span>
            </h1>
            <p className="welcome-lede">
              Issue keys, manage activations and verify offline access on infrastructure you
              control.
            </p>
            <div className="welcome-actions">
              <Button asChild size="lg">
                <a href="/docs/getting-started">
                  Get started <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </a>
              </Button>
              <Button variant="outline" asChild size="lg">
                <a href={source} target="_blank" rel="noreferrer">
                  View source <GitBranch data-icon="inline-end" aria-hidden="true" />
                </a>
              </Button>
            </div>
            <ul className="welcome-proof" aria-label="KeyForge project facts">
              <li>
                <Check aria-hidden="true" /> MIT licensed
              </li>
              <li>
                <Check aria-hidden="true" /> Node.js service
              </li>
              <li>
                <Check aria-hidden="true" /> SQLite or PostgreSQL
              </li>
            </ul>
          </div>
          <figure className="welcome-preview">
            <div className="welcome-preview-bar">
              <span>KeyForge console</span>
              <span>Plans · demo workspace</span>
            </div>
            <img
              src={`/welcome-console-${theme}.png`}
              width="1200"
              height="720"
              alt="KeyForge Plans screen showing demo plan terms and pricing. No customer data is shown."
              fetchPriority="high"
            />
            <figcaption>Plans, activations and license delivery in one console.</figcaption>
          </figure>
        </section>

        <section
          id="capabilities"
          className="welcome-capabilities"
          aria-labelledby="capabilities-title"
        >
          <div className="welcome-container">
            <div className="welcome-section-heading">
              <p className="welcome-eyebrow">KeyForge at a glance</p>
              <h2 id="capabilities-title">The licensing tools your app needs.</h2>
            </div>
            <div className="welcome-capability-grid">
              {capabilities.map(({ icon: Icon, title, description }) => (
                <article className="welcome-capability" key={title}>
                  <Icon aria-hidden="true" />
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className="welcome-container welcome-flow welcome-section"
          aria-labelledby="workflow-title"
        >
          <div className="welcome-section-heading">
            <p className="welcome-eyebrow">From plan to app</p>
            <h2 id="workflow-title">A clear path from sale to access.</h2>
          </div>
          <ol className="welcome-steps">
            {steps.map(([title, description], index) => (
              <li key={title}>
                <span className="welcome-step-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="integrate" className="welcome-integration" aria-labelledby="integration-title">
          <div className="welcome-container welcome-integration-layout">
            <div className="welcome-integration-copy">
              <p className="welcome-eyebrow">Application integration</p>
              <h2 id="integration-title">Keep the signing key on your server.</h2>
              <p>
                Use the TypeScript SDK or HTTP API. Pin public verification keys in your app and
                provide secure storage for its license state.
              </p>
              <ul className="welcome-checks">
                <li>
                  <Check aria-hidden="true" /> Online activation and refresh
                </li>
                <li>
                  <Check aria-hidden="true" /> Signed offline authorization
                </li>
                <li>
                  <Check aria-hidden="true" /> API and OpenAPI for other languages
                </li>
              </ul>
              <a className="welcome-text-link" href="/docs/dependent-app-integration">
                Read the integration guide <ArrowRight aria-hidden="true" />
              </a>
            </div>
            <div className="welcome-code">
              <div>
                <Code2 aria-hidden="true" />
                <span>Inside your application</span>
              </div>
              <pre>
                <code>{`const client = new KeyForgeClient({\n  serverUrl,\n  productId,\n  publicKeys, // pinned verification keys\n  storage,    // secure storage adapter\n});\n\nawait client.activate(licenseKey);\nconst access = await client.getAuthorization();\n\nif (access.state === "licensed") {\n  // Check entitlements at the protected action.\n}`}</code>
              </pre>
              <p>Offline access ends at the signed authorization deadline.</p>
            </div>
          </div>
        </section>

        <section className="welcome-boundaries" aria-labelledby="boundaries-title">
          <div className="welcome-container">
            <div className="welcome-section-heading">
              <p className="welcome-eyebrow">Before you deploy</p>
              <h2 id="boundaries-title">Know how it runs.</h2>
            </div>
            <div className="welcome-boundary-grid">
              {boundaries.map(([title, description], index) => (
                <article key={title}>
                  {index === 0 ? (
                    <Database aria-hidden="true" />
                  ) : index === 1 ? (
                    <ShieldCheck aria-hidden="true" />
                  ) : (
                    <ListChecks aria-hidden="true" />
                  )}
                  <h3>{title}</h3>
                  <p>{description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="welcome-footer">
        <div className="welcome-container welcome-footer-inner">
          <div>
            <Link className="welcome-brand" to="/welcome">
              <KeyRound aria-hidden="true" />
              KeyForge
            </Link>
            <p>MIT-licensed software for self-hosting.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href={source + "/blob/main/LICENSE"}>MIT license</a>
            <a href="/docs">Documentation</a>
            <a href={source} target="_blank" rel="noreferrer">
              <GitBranch aria-hidden="true" /> Source on GitHub
            </a>
            <Link to="/login">Sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
