import { Upload, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { ErrorNote } from "../components";

export function ProfileImage({
  value,
  onChange,
  name,
  onBusy,
}: {
  value: string;
  onChange: (value: string) => void;
  name: string;
  onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  async function choose(file: File | null) {
    const current = ++generation.current;
    setError("");
    if (!file) onChange("");
    if (!file) {
      onBusy(false);
      return;
    }
    onBusy(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw new Error("Choose a PNG, JPEG or WebP image.");
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        bitmap.close();
        throw new Error("Image processing is unavailable in this browser.");
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const image = canvas.toDataURL("image/webp", 0.85);
      if (image.length > 350000)
        throw new Error("This image is too large after resizing. Choose a smaller image.");
      if (generation.current === current) onChange(image);
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : "Could not read this image.");
    } finally {
      if (generation.current === current) onBusy(false);
    }
  }
  return (
    <section className="profile-avatar-section" aria-label="Profile image">
      <Avatar className="size-24">
        <AvatarImage src={value || undefined} alt="Profile preview" />
        <AvatarFallback className="text-2xl">
          {name.slice(0, 2).toUpperCase() || "?"}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Profile image</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            PNG, JPEG or WebP, up to 5 MB. Changes apply when you save your profile.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-label="Upload profile image"
            onClick={() => input.current?.click()}
          >
            <Upload data-icon="inline-start" />
            Upload image
          </Button>
          <Button
            variant="ghost"
            disabled={!value}
            onClick={() => {
              if (input.current) input.current.value = "";
              void choose(null);
            }}
          >
            <Trash2 data-icon="inline-start" />
            Remove
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Choose profile image"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
            event.target.value = "";
          }}
        />
      </div>
      {error && <ErrorNote message={error} />}
    </section>
  );
}
