"use client";

import { cn } from "cn";
import { UserIcon, UploadIcon, Trash2Icon, CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/reui/alert";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { formatBytes, useFileUpload, type FileWithPreview } from "@/hooks/use-file-upload";

interface AvatarUploadProps {
  maxSize?: number;
  className?: string;
  onFileChange?: (file: FileWithPreview | null) => void;
  defaultAvatar?: string;
  accept?: string;
  name?: string;
}

export function Pattern({
  maxSize = 2 * 1024 * 1024, // 2MB
  className,
  onFileChange,
  defaultAvatar,
  accept = "image/png,image/jpeg,image/webp",
  name = "",
}: AvatarUploadProps) {
  const [
    { files, isDragging, errors },
    {
      clearFiles,
      handleDragEnter,
      handleDragLeave,
      handleDragOver,
      handleDrop,
      openFileDialog,
      getInputProps,
    },
  ] = useFileUpload({
    maxFiles: 1,
    maxSize,
    accept,
    multiple: false,
    onFilesAdded: (files) => {
      onFileChange?.(files[0] || null);
    },
  });

  const currentFile = files[0];
  const previewUrl = currentFile?.preview || defaultAvatar;

  const handleRemove = () => {
    clearFiles();
    onFileChange?.(null);
  };

  return (
    <div className={cn("flex flex-col gap-5 sm:flex-row sm:items-start", className)}>
      {/* Avatar Preview */}
      <div className="relative shrink-0">
        <input {...getInputProps({ "aria-label": "Choose profile image" })} className="sr-only" />
        <button
          type="button"
          aria-label={previewUrl ? "Replace profile image" : "Upload profile image"}
          className={cn(
            "group/avatar relative size-24 cursor-pointer overflow-hidden rounded-full border border-dashed transition-colors",
            isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25",
            previewUrl && "border-solid",
          )}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={openFileDialog}
        >
          <Avatar className="size-full">
            <AvatarImage src={previewUrl || undefined} alt="Profile preview" />
            <AvatarFallback>
              {name.slice(0, 2).toUpperCase() || <UserIcon aria-hidden="true" />}
            </AvatarFallback>
          </Avatar>
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <div>
          <h2 className="text-base font-semibold">Profile image</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose an image to help operators recognize you.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            PNG, JPEG or WebP, up to {formatBytes(maxSize)}. Resized to 256 pixels.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={openFileDialog}>
            <UploadIcon data-icon="inline-start" />
            Upload image
          </Button>
          <Button type="button" variant="outline" onClick={handleRemove} disabled={!previewUrl}>
            <Trash2Icon data-icon="inline-start" />
            Remove
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Save your profile to apply changes.</p>
      </div>
      {/* Error Messages */}
      {errors.length > 0 && (
        <Alert variant="destructive" className="mt-5">
          <CircleAlertIcon />
          <AlertTitle>File upload error(s)</AlertTitle>
          <AlertDescription>
            {errors.map((error, index) => (
              <p key={index} className="last:mb-0">
                {error}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
