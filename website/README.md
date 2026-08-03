# OPC Studio release website

Static Cloudflare Pages site for the Windows Private Alpha release.

## Cloudflare Pages settings

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `website`
- Root directory: repository root

The download buttons point directly to the installer stored in GitHub Releases.

## Direct upload

```bash
npx wrangler pages deploy website --project-name opc-studio
```

After the first deployment, add the chosen custom domain in **Workers & Pages → opc-studio → Custom domains**. The domain's DNS zone must be managed by the same Cloudflare account.
