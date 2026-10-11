import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter, subscriptionsSchema } from '../../src/adapters/drizzle.adapter.ts';
/** Instantiate the shipped SQLite schema including actual unique indexes/FKs. */
export function sqliteDatabase() {
    const connection = new Database(':memory:');
    connection.exec('PRAGMA foreign_keys = ON');
    for (const table of Object.values(subscriptionsSchema)) {
        const config = getTableConfig(table);
        const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}`);
        for (const fk of config.foreignKeys) {
            const ref = fk.reference();
            columns.push(`FOREIGN KEY (${ref.columns.map(column => `"${column.name}"`).join(',')}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map(column => `"${column.name}"`).join(',')})`);
        }
        connection.exec(`CREATE TABLE "${config.name}" (${columns.join(',')})`);
        for (const index of config.indexes) {
            const item = index.config;
            connection.exec(`CREATE ${item.unique ? 'UNIQUE ' : ''}INDEX "${item.name}" ON "${config.name}" (${item.columns.map(column => `"${(column as {
                name: string;
            }).name}"`).join(',')})`);
        }
    }
    return { connection, database: drizzleAdapter(drizzle(connection, { schema: subscriptionsSchema })) };
}
