// Fixture for the configured call-extractor feature.
// All calls import buildFixtureMeta from '@test/fixture-seo', which matches the
// package filter in the fixture config. Expected extracted keys are documented below.
import {buildFixtureMeta, buildRootFixtureMeta} from '@test/fixture-seo';

// Case (a): literal namespace + literal key.
// expect: widget.landing.metadata.root.title, widget.landing.metadata.root.description
export const metaA = () =>
    buildFixtureMeta({namespace: 'widget.landing', key: 'root'});

// Case (b): no-arg call → namespace.default='common', defaults.key='root'.
// expect: common.metadata.root.title, common.metadata.root.description
export const metaB = () => buildRootFixtureMeta();

// Case (c): union-typed key prop fans out to multiple keys.
type PageKey = 'detail' | 'list';
export const metaC = (key: PageKey) =>
    buildFixtureMeta({namespace: 'widget.landing', key});
// expect: widget.landing.metadata.detail.title, widget.landing.metadata.detail.description,
//         widget.landing.metadata.list.title,   widget.landing.metadata.list.description
