---
name: cpanel
description: "Use when: generating a cPanel deployment file, deploying a Node.js app to cPanel, checking app root paths, or validating Passenger restart workflows for TypeScript or backend web apps."
---

# cPanel Deployment Workflow

## Objective

Create a valid cPanel deployment file for shared hosting, especially for Node.js or TypeScript apps that build locally and deploy with Phusion Passenger.

## Workflow

1. Confirm the deployment target.
   - Ask for the cPanel username.
   - Ask for the app root path on the server, such as `/home/[USERNAME]/repo/[APP_NAME]`.
   - Confirm whether the project is a backend API, a build artifact deployment, or a monorepo.

2. Confirm the runtime and build step.
   - If the project uses TypeScript or another build step, build it locally or in CI before deployment.
   - Never run `vp install` or `vp run build` inside the cPanel task script unless the hosting environment explicitly supports it.

3. Design the deployment structure.
   - Keep the app in a dedicated project folder.
   - Create `tmp/` for Passenger restart and `database/` or equivalent for persistent files.
   - Do not copy `node_modules/`, `.git/`, or local ephemeral caches.

4. Deploy only runtime artifacts.
   - Copy the compiled output, package metadata, and minimal runtime scripts.
   - Preserve configuration outside the repo, especially secrets and signing keys.

5. Ensure the database and runtime state are safe.
   - Create an empty SQLite file only if it does not exist.
   - Never overwrite a production database or a populated storage directory.

6. Restart the app.
   - Touch `tmp/restart.txt` in the app root to trigger Passenger reload.
   - This is the standard reset action for cPanel Node deployments.

7. Validate before completion.
   - Check that the app root path matches the deployed directory.
   - Check that environment variables are configured in cPanel.
   - Ensure the app starts from the correct path, such as `./dist/src/index.js` — check where the build actually puts it,
     since a `rootDir` above `src/` keeps the prefix.

## Best Practices

- Use `.cpanel.yml` with the exact cPanel filename. `.cpanel.yaml` is not the expected cPanel file format.
- Use absolute binaries like `/bin/mkdir`, `/bin/cp`, and `/bin/touch`.
- Keep shell logic in a single multi-line YAML block using `|`.
- Keep all secrets in environment variables managed by cPanel, not committed to the repo.
- For Node backend apps, prefer a local build step and deploy just the compiled result.
- For static frontend apps, deploy the built `dist` or `build` directory to the web root instead of source files.
- For monorepos, explicitly target only the required subfolders.

## Deployment Template

```yaml
---
deployment:
  tasks:
    - |
      export CPANEL_USER="[YOUR_CPANEL_USERNAME]"
      export APP_DIR="/home/$CPANEL_USER/[APP_FOLDER_NAME]"

      /bin/mkdir -p "$APP_DIR"
      /bin/mkdir -p "$APP_DIR/tmp"
      /bin/mkdir -p "$APP_DIR/database"

      /bin/cp -R dist "$APP_DIR/"
      /bin/cp package.json package-lock.json "$APP_DIR/"
      /bin/cp -R scripts "$APP_DIR/"

      if [ ! -f "$APP_DIR/database/licenses.sqlite" ]; then
        /bin/touch "$APP_DIR/database/licenses.sqlite"
      fi

      /bin/touch "$APP_DIR/tmp/restart.txt"
```

## Completion Checklist

- cPanel username verified
- app root directory matches the actual deployment path
- build output exists before deploy
- no `node_modules` copied
- env vars configured in cPanel
- `tmp/restart.txt` touched
- runtime database file initialized safely
- app entry path matches the built artifact
