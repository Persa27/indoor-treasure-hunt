# IndoorTreasureHunt プロジェクトルール

室内AR宝探しWebアプリ。仕様は [SPEC.md](SPEC.md) を参照。

## Git運用ルール

- **初回push**: MVP開発完了時(SPEC.md「MVP実装順序」セクションの1〜5が動作した時点)に、GitHubへ最初のpushを行う。
- **以降のpush**: 修正・機能追加が完了しビルド検証が通ったら、**その都度即座にコミット+pushする**(Vercelの自動デプロイに反映させるため)。コミットをローカルに溜め込まない。
- pushは `main` ブランチへ行う(Vercelが自動デプロイするため、動作確認済みの状態でpushすること)。
