/**
 * Git refuses to create a commit without an author identity. Developer
 * machines usually have a global git config, but a fresh CI runner does not,
 * so tests that commit through the git service would fail there.
 */
process.env.GIT_AUTHOR_NAME ??= 'Nest Test';
process.env.GIT_AUTHOR_EMAIL ??= 'nest-test@example.com';
process.env.GIT_COMMITTER_NAME ??= 'Nest Test';
process.env.GIT_COMMITTER_EMAIL ??= 'nest-test@example.com';

export {};
