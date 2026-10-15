import { LockKeyhole, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
type Participant = { id: string; name: string };
type Message = { id: string; authorId: string; text: string; createdAt: string };
/** Email-style operator history composed from shadcn primitives; content stays API-owned. */
export function ConversationThread({
  participants,
  messages,
  label,
  internal = false,
}: {
  participants: Participant[];
  messages: Message[];
  label: string;
  internal?: boolean;
}) {
  return (
    <section aria-label={label} className="conversation-messages">
      {messages.length === 0 && (
        <p className="p-6 text-sm text-muted-foreground">No messages in this history.</p>
      )}
      {messages.map((message) => {
        const author =
          participants.find((p) => p.id === message.authorId)?.name ?? message.authorId;
        return (
          <article key={message.id} className="conversation-message">
            <Avatar className="size-8">
              <AvatarFallback>
                {message.authorId === "customer" ? (
                  <UserRound aria-hidden="true" />
                ) : (
                  author.slice(0, 2).toUpperCase()
                )}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{author}</span>
                {internal && (
                  <Badge variant="secondary">
                    <LockKeyhole data-icon="inline-start" />
                    Internal note
                  </Badge>
                )}
                <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
                  {new Date(message.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
            </div>
          </article>
        );
      })}
    </section>
  );
}
