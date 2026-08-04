<div align="center">

# OPC Studio

**長期間稼働する AI チームのための、ローカル優先かつ検証可能なワークシステム。**

[English](./README.md) · [简体中文](./README_ZH.md) · [日本語](./README_JA.md) · [Deutsch](./README_DE.md)

[![GitHub stars](https://img.shields.io/github/stars/WUBING2023/OPCStudio?style=flat-square&label=Stars)](https://github.com/WUBING2023/OPCStudio/stargazers)
[![Latest release](https://img.shields.io/github/v/release/WUBING2023/OPCStudio?style=flat-square&label=Release)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-171817?style=flat-square)](https://github.com/WUBING2023/OPCStudio/releases/latest)
[![License](https://img.shields.io/github/license/WUBING2023/OPCStudio?style=flat-square)](./LICENSE)

[公式サイト](https://opcstudio.pages.dev/) · [ダウンロード](https://github.com/WUBING2023/OPCStudio/releases/latest) · [ドキュメント](#ドキュメント) · [問題を報告](https://github.com/WUBING2023/OPCStudio/issues)

</div>

![OPC Studio company workspace](./website/assets/opc-studio-home.png)

## OPC Studio とは

OPC Studio は、API モデルとサブスクリプション型 CLI を再利用可能な AI 企業として編成します。企業は長期的な役割、責任、権限、ツール、検証規則、管理されたメモリを定義し、各 Mission は目的に合ったタスクグラフと一時的な実行チームを作成します。

目的は Agent 同士の会話を増やすことではありません。AI の仕事を**追跡可能、検証可能、再利用可能にし、失敗を正直に扱うこと**です。

> **リリースチャネル:** Windows Private Alpha。プロバイダー権限と[セキュリティ境界](./docs/security-boundary.md)を確認するまでは、機密性のないテストプロジェクトで使用してください。

## コアモデル

```text
組織レイヤー    役割 · 責任 · 権限 · Skill · MCP · メモリ
タスクレイヤー  Mission グラフ · 依存関係 · 成果物契約 · 承認点
実行レイヤー    モデルセッション · worktree · ツール · 一時 A2A メッセージ
証拠レイヤー    成果物 · hash · テスト · 系譜 · 正直な最終状態
```

- **永続的な企業**が再利用可能な組織能力を保持します。
- **動的なチーム**が不要な全員参加を防ぎます。
- **実際のワークスペース**に本物のファイル変更と成果物を残します。
- **独立検証**がテストと証拠を実際の成果物に結び付けます。
- **管理されたメモリ**が提案、承認、拒否、失効を分離します。
- **バージョン付き Company Bundle**が移行、信頼表示、忠実度検査を支えます。

## ダウンロード

最新の Windows インストーラーは [GitHub Releases](https://github.com/WUBING2023/OPCStudio/releases/latest) から取得できます。

- Windows 10/11 x64
- インストーラー：約 127 MiB
- インストール後：約 472 MiB
- API キーやサブスクリプション資格情報は同梱されません

現在の配布パッケージは Windows 専用です。ソース開発は Windows、macOS、Linux で可能ですが、他のプラットフォームではパッケージ版の完全な検証がまだ完了していません。

## ソースから起動

Node.js 24.x と pnpm 11.7.0 が必要です。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`http://localhost:5173` を開きます。実際のタスクを開始する前に、API プロバイダーまたは対応するサブスクリプション CLI を設定してください。資格情報はリポジトリ外に保存します。詳細は [Repository Setup](./docs/REPOSITORY_SETUP.md) を参照してください。

## ビルドと検証

```bash
pnpm -r typecheck
pnpm test
pnpm run test:security-gate
pnpm run build:electron
```

Windows インストーラーは `electron-app/release/` に生成されます。

## アーキテクチャ

```text
apps/web        React + Vite のデスクトップ / Web UI
apps/server     制御面、オーケストレーション、ストレージ、証拠、メモリ
apps/cli        Headless CLI、MCP Server、ACP / ネイティブ実行アダプター
packages/shared バージョン付き契約とスキーマ
electron-app    自己完結型 Windows デスクトップパッケージ
integrations    Codex / Claude 統合バンドル
```

## コミュニティマップ

[公式サイト](https://opcstudio.pages.dev/#community)には実際の Star 数と集約済み Stargazer マップが表示されます。位置情報はユーザーが GitHub に公開した情報だけを利用し、国・地域単位で集約します。ユーザー名、生の位置文字列、企業、自己紹介、訪問者 IP、正確な座標は公開しません。Star からインストール数やアクティブユーザー数を推測することもありません。

## セキュリティ

OPC Studio は強力なローカルツールを実行します。第三者のテンプレート、Skill、MCP Server、サブスクリプション CLI は重要なホスト権限を持つ場合があります。パス保護、SSRF 対策、資格情報のマスキング、承認制御、隔離された作業ルート、証拠検証を備えていますが、完全なコンテナサンドボックスではありません。

## Private Alpha の制限

- パッケージ版とインストール検証が完了しているのは Windows x64 のみです。
- 一部の実行経路にはベンダー CLI と有効なアカウントが必要です。
- サブスクリプション利用では Token を記録しますが、リクエスト単位の正確な金額は保証できません。
- マルチ Agent は単一の強力な Agent より遅く高価になる場合があります。
- 公開テンプレート署名、モデレーション、完全なサンドボックス、クロスプラットフォーム配布は開発中です。

## ドキュメント

- [Repository Setup](./docs/REPOSITORY_SETUP.md)
- [Distribution](./docs/DISTRIBUTION.md)
- [Security Boundary](./docs/security-boundary.md)
- [Architecture decisions](./docs/adr/)
- [Product contract](./PRODUCT_CONTRACT.md)
- [Roadmap](./ROADMAP.md)

## ライセンス

現在は [Apache License 2.0](./LICENSE) の下で公開されています。