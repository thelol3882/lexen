// Fixture for the package-filter exclusion test.
// This file declares buildFixtureMeta locally (NOT importing from '@test/fixture-seo').
// The configured call extractor has package: '@test/fixture-seo', so this local
// declaration must NOT be treated as a match — zero keys should be extracted.

function buildFixtureMeta(_input: {namespace: string; key: string}): void {
    // local declaration — intentionally matches the callee name but not the package
}

// This call must NOT produce any extracted keys.
export const ignored = () =>
    buildFixtureMeta({namespace: 'widget.demo', key: 'localSecret'});
