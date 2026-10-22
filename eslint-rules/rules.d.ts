// Types for the plain JS rule modules, so the RuleTester spec typechecks.
declare module "*/drizzle-imports-only.js" {
	const rule: import("eslint").Rule.RuleModule
	export default rule
}
declare module "*/no-orm-in-controllers.js" {
	const rule: import("eslint").Rule.RuleModule
	export default rule
}
declare module "*/respect-repositories.js" {
	const rule: import("eslint").Rule.RuleModule
	export default rule
}
