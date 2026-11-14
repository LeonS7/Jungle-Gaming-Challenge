/**
 * Esta página representa indisponibilidade transitória de uma persistência.
 */
export class PersistenceUnavailableError extends Error {
  constructor() {
    super('O armazenamento financeiro está temporariamente indisponível.');
    this.name = 'PersistenceUnavailableError';
  }
}
