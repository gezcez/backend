-- Full text search over routes and stops (plan 5.2). Text is Turkish-folded in code before
-- insert and before MATCH (ı->i, ş->s, ğ->g, ü->u, ö->o, ç->c, lowercase); rebuilt per version.
CREATE VIRTUAL TABLE `search_index` USING fts5(
	`kind` UNINDEXED,
	`ref_id` UNINDEXED,
	`version_id` UNINDEXED,
	`binding_id` UNINDEXED,
	`text`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '1 2 3'
);
