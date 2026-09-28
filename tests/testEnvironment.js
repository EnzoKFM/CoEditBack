import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const testDatabaseName = process.env.DB_TEST_NAME ?? 'coedit_test';
const applicationDatabaseName = process.env.DB_APPLICATION_NAME ?? process.env.DB_NAME;
process.env.DB_APPLICATION_NAME = applicationDatabaseName;

if (testDatabaseName === applicationDatabaseName) {
  throw new Error('DB_TEST_NAME doit être différent de DB_NAME : les tests vident la base');
}

process.env.DB_NAME = testDatabaseName;
process.env.JWT_SECRET ||= 'secret-de-test-uniquement-assez-long-pour-le-controle';
process.env.TOTP_ENCRYPTION_KEY ||= '0'.repeat(64);
