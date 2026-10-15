import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Menu,
  Search,
} from "lucide-react";
import { isValidElement, useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { ThemeControl } from "../components/ThemeControl";
import { docPath, resolveDocHref, sourceRepository } from "../docs/catalog";
import { articles, openApiUrl } from "../docs/content";
import { headingIds, searchDocs, type DocArticle } from "../docs/markdown";

function Navigation({ current, close }: { current: string; close?: () => void }) {
  return (
    <nav aria-label="Documentation navigation" className="docs-navigation">
      {[...new Set(articles.map((a) => a.group))].map((group) => (
        <div key={group}>
          <p className="docs-nav-group">{group}</p>
          {articles
            .filter((a) => a.group === group)
            .map((article) => (
              <Link
                key={article.slug}
                to={docPath(article.slug)}
                aria-current={article.slug === current ? "page" : undefined}
                onClick={close}
              >
                {article.title}
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
}
function SearchDocs() {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const results = searchDocs(articles, query);
  return (
    <>
      <Button
        variant="outline"
        className="docs-search-trigger"
        aria-label="Search documentation"
        aria-keyshortcuts="Control+k Meta+k"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <Search data-icon="inline-start" />
        <span>Search documentation</span>
        <kbd>Ctrl K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="docs-search-dialog">
          <DialogHeader className="sr-only">
            <DialogTitle>Search documentation</DialogTitle>
            <DialogDescription>
              Search guide titles, headings and article text. Use arrow keys to choose a result.
            </DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="Search all guides"
              placeholder="Try signing keys, Render or activation…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                No matching guides. Try fewer words or browse the navigation.
              </CommandEmpty>
              <CommandGroup heading={query.trim() ? "Matching sections" : "Browse guides"}>
                {results.map((result) => (
                  <CommandItem
                    key={result.article.slug + ":" + result.id}
                    value={result.article.slug + ":" + result.id}
                    onSelect={() => {
                      setOpen(false);
                      navigate(docPath(result.article.slug) + (result.id ? "#" + result.id : ""));
                    }}
                  >
                    <BookOpen aria-hidden="true" />
                    <div className="docs-search-result">
                      <span>
                        {result.article.title}
                        {result.id && result.title !== result.article.title
                          ? " / " + result.title
                          : ""}
                      </span>
                      <p>{result.snippet}</p>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const code = isValidElement<{ children?: ReactNode }>(children)
    ? String(children.props.children ?? "")
    : "";
  return (
    <div className="docs-code-block">
      <div className="docs-code-toolbar">
        <span>Code example</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied("copied");
            } catch {
              setCopied("failed");
            }
          }}
        >
          {copied === "copied" ? (
            <Check data-icon="inline-start" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          {copied === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll long code lines. */}
      <pre tabIndex={0} aria-label="Code example">
        {children}
      </pre>
      <output className={copied === "failed" ? "docs-copy-error" : "sr-only"}>
        {copied === "failed"
          ? "Clipboard unavailable. Select the code and copy it manually."
          : copied === "copied"
            ? "Code copied to clipboard."
            : ""}
      </output>
    </div>
  );
}
function MobileContents({ article }: { article: DocArticle }) {
  const [expanded, setExpanded] = useState("");
  if (!article.headings.length) return null;
  return (
    <Accordion
      type="single"
      collapsible
      value={expanded}
      onValueChange={setExpanded}
      className="docs-mobile-toc"
    >
      <AccordionItem value="contents">
        <AccordionTrigger>On this page</AccordionTrigger>
        <AccordionContent>
          <nav aria-label="On this page">
            {article.headings.map((heading) => (
              <Link key={heading.id} to={"#" + heading.id} onClick={() => setExpanded("")}>
                {heading.title}
              </Link>
            ))}
          </nav>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
function Article({ article }: { article: DocArticle }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, headingIds]}
      skipHtml
      disallowedElements={["img"]}
      components={{
        h1: ({ children, id }) => (
          <>
            <h1 id={id}>{children}</h1>
            <MobileContents article={article} />
          </>
        ),
        a({ href, children }) {
          const target = resolveDocHref(href ?? "", article.source, articles, openApiUrl);
          if (!target) return <span>{children}</span>;
          if (target.startsWith("/docs") && !target.startsWith("/docs/../"))
            return <Link to={target}>{children}</Link>;
          return (
            <a
              href={target}
              {...(target.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {children}
            </a>
          );
        },
        pre: CodeBlock,
        table: ({ children }) => (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll wide reference tables.
          <section className="docs-table-scroll" tabIndex={0} aria-label="Reference table">
            <table>{children}</table>
          </section>
        ),
      }}
    >
      {article.markdown}
    </Markdown>
  );
}

export default function Docs() {
  const { slug = "" } = useParams(),
    location = useLocation();
  const article = articles.find((a) => a.slug === slug);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    document.title = (article?.title ?? "Guide not found") + " — KeyForge documentation";
    if (location.hash) {
      let id: string;
      try {
        id = decodeURIComponent(location.hash.slice(1));
      } catch {
        return;
      }
      document.getElementById(id)?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
      document.getElementById("docs-main")?.focus({ preventScroll: true });
    }
  }, [article, location.pathname, location.hash]);
  const position = article ? articles.indexOf(article) : -1,
    previous = articles[position - 1],
    next = position >= 0 ? articles[position + 1] : undefined;
  return (
    <div className="docs-page">
      <a className="welcome-skip" href="#docs-main">
        Skip to documentation
      </a>
      <header className="docs-header">
        <div className="docs-header-inner">
          <Link to="/welcome" className="docs-brand" aria-label="KeyForge home">
            <KeyRound aria-hidden="true" />
            <span>KeyForge</span>
          </Link>
          <Link className="docs-header-title" to="/docs">
            Documentation
          </Link>
          <SearchDocs />
          <ThemeControl />
          <Button asChild variant="outline" size="sm">
            <Link to="/login">Sign in</Link>
          </Button>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button
                className="docs-menu-trigger"
                variant="ghost"
                size="icon"
                aria-label="Open documentation navigation"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="docs-menu-sheet">
              <SheetHeader>
                <SheetTitle>Documentation</SheetTitle>
                <SheetDescription>
                  Setup, administration and application integration.
                </SheetDescription>
              </SheetHeader>
              <Navigation current={slug} close={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <Navigation current={slug} />
        </aside>
        <main id="docs-main" className="docs-main" tabIndex={-1}>
          {article ? (
            <>
              <div className="docs-prose" key={article.slug}>
                <Article article={article} />
              </div>
              <div className="docs-article-source">
                <span>Included with this deployment</span>
                <a
                  href={sourceRepository + "/blob/main/" + article.source}
                  target="_blank"
                  rel="noreferrer"
                >
                  View Markdown source <ExternalLink aria-hidden="true" />
                </a>
              </div>
              <nav className="docs-pagination" aria-label="Previous and next guides">
                <div>
                  {previous && (
                    <Link to={docPath(previous.slug)}>
                      <ArrowLeft aria-hidden="true" />
                      <span>
                        <small>Previous</small>
                        {previous.title}
                      </span>
                    </Link>
                  )}
                </div>
                <div>
                  {next && (
                    <Link to={docPath(next.slug)}>
                      <span>
                        <small>Next</small>
                        {next.title}
                      </span>
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  )}
                </div>
              </nav>
            </>
          ) : (
            <div className="docs-not-found">
              <h1>Guide not found</h1>
              <p>
                This guide is not included in this deployment. Browse the documentation or search
                for the topic you need.
              </p>
              <Button asChild>
                <Link to="/docs">Open documentation</Link>
              </Button>
            </div>
          )}
        </main>
        {article && (
          <aside className="docs-toc">
            <nav aria-label="On this page">
              <p>On this page</p>
              {article.headings.map((h) => (
                <a
                  className={h.depth === 3 ? "docs-toc-nested" : undefined}
                  key={h.id}
                  href={"#" + h.id}
                >
                  {h.title}
                </a>
              ))}
              <a className="docs-openapi" href={openApiUrl} download="keyforge-client-openapi.json">
                Download client OpenAPI <ExternalLink aria-hidden="true" />
              </a>
            </nav>
          </aside>
        )}
      </div>
      <footer className="docs-footer">
        <Link to="/welcome">KeyForge</Link>
        <span>MIT-licensed software for self-hosting</span>
        <a href={sourceRepository} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>
    </div>
  );
}
