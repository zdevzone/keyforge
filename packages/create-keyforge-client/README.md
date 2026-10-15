# create-keyforge-client

Create a separate Node.js integration starter for `@zdevzone/keyforge-client`.

From this repository:

```sh
node packages/create-keyforge-client/bin/create-keyforge-client.mjs ../my-client
```

Or use Vite+:

```sh
vp create keyforge-client
vp create keyforge-client -- my-client --server-url https://licenses.example.com --product studio --yes
```

Existing apps install the SDK with `vp add @zdevzone/keyforge-client`; do not run a project generator over an existing app.

The starter includes explicit onboarding commands, optional cross-platform device recognition, public-key pinning and a secure-storage adapter boundary. `vp run demo` uses memory for a local status check only. Real activation, trials and offline restart require implementing secure atomic storage. No private signing keys or console/admin credentials are generated or requested.

See the [SDK guide](../keyforge-client/README.md). Maintainers: see the [package release guide](../../docs/publishing.md).
