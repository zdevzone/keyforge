import { useQuery } from "@tanstack/react-query";
import { Search, KeyRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem as CommandOption,
  CommandEmpty,
} from "@/components/ui/command";

import { fetchLicenses } from "../api";
import { Modal } from "../components";
import { useProduct } from "../platform-ui";
type CommandItem = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  icon?: ReactNode;
};

export function GlobalCommand({ items }: { items: CommandItem[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        // Do not open a second dialog over an active edit flow.
        if (!open && document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [open]);
  return (
    <div className="console-global-command">
      <button
        type="button"
        className="console-command-trigger"
        onClick={() => setOpen(true)}
        aria-label="Search licenses and commands"
        aria-keyshortcuts="Control+k Meta+k"
      >
        <Search aria-hidden="true" />
        <span>Search licenses or go to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open && <SearchDialog items={items} close={() => setOpen(false)} />}
    </div>
  );
}

function SearchDialog({ items, close }: { items: CommandItem[]; close: () => void }) {
  const navigate = useNavigate();
  const { id } = useProduct();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useQuery({
    queryKey: ["command-licenses", id, debounced],
    queryFn: () => fetchLicenses({ q: debounced, pageSize: 8 }),
    enabled: Boolean(debounced),
  });
  const commands: CommandItem[] = [...items];
  if (query.trim()) {
    commands.unshift({
      id: "search-all",
      label: `Search licenses for “${query.trim()}”`,
      group: "Licenses",
      keywords: [query],
      icon: <Search />,
    });
    if (debounced === query.trim())
      for (const license of results.data?.licenses ?? [])
        commands.push({
          id: "/licenses/" + license.id,
          label: license.issuedTo || license.id,
          description: license.plan + " · " + license.id,
          group: "Matching licenses",
          keywords: [query],
          icon: <KeyRound />,
        });
  }
  return (
    <Modal title="Search & navigation" onClose={close}>
      <div className="console-palette">
        <Command
          shouldFilter={false}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        >
          <CommandInput
            aria-label="Search licenses and commands"
            placeholder="Customer, plan, license or page…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No matching commands or licenses.</CommandEmpty>
            {Array.from(new Set(commands.map((item) => item.group ?? "Navigation"))).map(
              (group) => (
                <CommandGroup key={group} heading={group}>
                  {commands
                    .filter(
                      (item) =>
                        (item.group ?? "Navigation") === group &&
                        ((group !== "Navigation" && !items.includes(item)) ||
                          (item.label + " " + (item.keywords ?? []).join(" "))
                            .toLowerCase()
                            .includes(query.toLowerCase())),
                    )
                    .map((item) => (
                      <CommandOption
                        key={item.id}
                        value={item.id}
                        onSelect={() => {
                          navigate(
                            item.id === "search-all"
                              ? "/?q=" + encodeURIComponent(query.trim())
                              : item.id,
                          );
                          close();
                        }}
                      >
                        {item.icon}
                        <span className="flex min-w-0 flex-col">
                          <span>{item.label}</span>
                          {item.description && (
                            <span className="truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          )}
                        </span>
                      </CommandOption>
                    ))}
                </CommandGroup>
              ),
            )}
          </CommandList>
        </Command>
        {results.isFetching && (
          <output className="mt-3 text-sm text-muted-foreground">
            Searching this product’s licenses…
          </output>
        )}
        {results.error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            License search could not load. Try again from Licenses.
          </p>
        )}
      </div>
    </Modal>
  );
}
