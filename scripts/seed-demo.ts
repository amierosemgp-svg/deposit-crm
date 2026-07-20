/* Seed demo/sample data on top of the base skeleton from `pnpm db:seed`:
 *   players, company bank accounts, game credits, deposits across all
 *   statuses, withdrawals, game transfers, bank transfers, provider BO
 *   accounts, and matching audit-log transactions.
 * Additive but re-runnable: wipes data tables first, keeps entities/users/
 * api_keys/settings from the base seed.
 *
 * Run: pnpm tsx --env-file=.env.local scripts/seed-demo.ts
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  bankAccounts,
  bankTransfers,
  deposits,
  entities,
  gameCredits,
  gameTransfers,
  players,
  providerBoAccounts,
  transactions,
  users,
  withdrawals,
} from "../src/db/schema";

const day = (d: number, h = 12, m = 0) =>
  new Date(Date.UTC(2026, 6, d, h - 8, m)).toISOString(); // +08:00 → UTC

async function main() {
  const [company] = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_type, "company"));
  if (!company) throw new Error("Run `pnpm db:seed` first — no company entity.");

  const allUsers = await db.select().from(users);
  const admin = allUsers.find((u) => u.username === "admin")!;
  const cs1 = allUsers.find((u) => u.username === "cs1")!;

  console.log("Clearing existing demo data…");
  await db.execute(sql`
    TRUNCATE TABLE
      transactions, provider_bo_adjustments, provider_bo_accounts,
      game_transfers, game_credits, withdrawals, deposits, bank_transfers,
      bank_accounts, players
    RESTART IDENTITY CASCADE
  `);

  console.log("Seeding company bank accounts…");
  const insertedAccounts = await db
    .insert(bankAccounts)
    .values([
      {
        entity_id: company.entity_id,
        role: "deposit" as const,
        bank_name: "Maybank",
        account_number: "512345678901",
        account_holder: "TAN KIEN HUAT",
        label: "MBB Deposit A",
        current_balance: 48230.5,
      },
      {
        entity_id: company.entity_id,
        role: "deposit" as const,
        bank_name: "CIMB",
        account_number: "7601234567",
        account_holder: "LIM WEI SENG",
        label: "CIMB Deposit B",
        current_balance: 21875.0,
      },
      {
        entity_id: company.entity_id,
        role: "withdrawal" as const,
        bank_name: "Public Bank",
        account_number: "4987654321",
        account_holder: "WONG MEI LING",
        label: "PBB Payout",
        current_balance: 15400.25,
      },
      {
        entity_id: company.entity_id,
        role: "withdrawal" as const,
        bank_name: "Hong Leong",
        account_number: "22301456789",
        account_holder: "TAN KIEN HUAT",
        label: "HLB Payout",
        current_balance: 9120.0,
      },
    ])
    .returning();
  const [mbbDep, cimbDep, pbbWdr, hlbWdr] = insertedAccounts;

  console.log("Seeding players…");
  const playerRows = [
    {
      username: "ahmad88",
      full_name: "Ahmad Faizal bin Rahman",
      contact_number: "+60123456789",
      telegram_username: "@ahmad_f88",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "Maybank", account_number: "157023456789", account_holder: "AHMAD FAIZAL BIN RAHMAN" },
      ],
      game_accounts: [
        { game_name: "Mega888", game_username: "MG_ahmad88" },
        { game_name: "918Kiss", game_username: "KS_ahmad88" },
      ],
      registration_date: day(1, 10),
      total_deposits: 1850,
      total_withdrawals: 600,
    },
    {
      username: "jenny_lee",
      full_name: "Jenny Lee Xiu Mei",
      contact_number: "+60167891234",
      telegram_username: "@jennylee_my",
      wechat_id: "jennylee92",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "CIMB", account_number: "7009876543", account_holder: "LEE XIU MEI" },
      ],
      game_accounts: [{ game_name: "Pussy888", game_username: "PS_jenny" }],
      registration_date: day(2, 14),
      total_deposits: 3200,
      total_withdrawals: 1500,
    },
    {
      username: "kumar_v",
      full_name: "Kumar a/l Vijayan",
      contact_number: "+60198765432",
      telegram_username: "@kumar_v7",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "Public Bank", account_number: "4123098765", account_holder: "KUMAR A/L VIJAYAN" },
      ],
      game_accounts: [
        { game_name: "XE88", game_username: "XE_kumar" },
        { game_name: "Mega888", game_username: "MG_kumar" },
      ],
      registration_date: day(3, 9),
      total_deposits: 950,
      total_withdrawals: 0,
    },
    {
      username: "wswong",
      full_name: "Wong Wai Shen",
      contact_number: "+60112223334",
      telegram_username: "@ws_wong",
      wechat_id: "wswong88",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "Hong Leong", account_number: "22398765432", account_holder: "WONG WAI SHEN" },
        { bank_name: "Maybank", account_number: "157098761234", account_holder: "WONG WAI SHEN" },
      ],
      game_accounts: [{ game_name: "918Kiss", game_username: "KS_wswong" }],
      registration_date: day(5, 20),
      total_deposits: 5400,
      total_withdrawals: 2800,
    },
    {
      username: "sitinor",
      full_name: "Siti Norhaliza binti Ismail",
      contact_number: "+60134567890",
      telegram_username: "@siti_nor",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "BSN", account_number: "0410098765432", account_holder: "SITI NORHALIZA BINTI ISMAIL" },
      ],
      game_accounts: [{ game_name: "Mega888", game_username: "MG_sitinor" }],
      registration_date: day(8, 11),
      total_deposits: 400,
      total_withdrawals: 0,
    },
    {
      username: "dchong",
      full_name: "Chong Ka Fai",
      contact_number: "+60176543210",
      telegram_username: "@d_chong",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "RHB", account_number: "26412345678", account_holder: "CHONG KA FAI" },
      ],
      game_accounts: [
        { game_name: "Pussy888", game_username: "PS_dchong" },
        { game_name: "XE88", game_username: "XE_dchong" },
      ],
      registration_date: day(10, 16),
      total_deposits: 2100,
      total_withdrawals: 900,
      status: "suspended" as const,
      notes: "Suspended 2026-07-16 — chargeback dispute on RHB transfer, pending review.",
    },
    {
      username: "mira_a",
      full_name: "Amira binti Zulkifli",
      contact_number: "+60145671122",
      telegram_username: "@mira_az",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "Ambank", account_number: "8881234567", account_holder: "AMIRA BINTI ZULKIFLI" },
      ],
      game_accounts: [{ game_name: "918Kiss", game_username: "KS_mira" }],
      registration_date: day(15, 13),
      total_deposits: 150,
      total_withdrawals: 0,
    },
    {
      username: "leong_ck",
      full_name: "Leong Chee Keong",
      contact_number: "+60129998877",
      telegram_username: "@leongck",
      wechat_id: "ck_leong",
      company_entity_id: company.entity_id,
      bank_accounts: [
        { bank_name: "Maybank", account_number: "157011223344", account_holder: "LEONG CHEE KEONG" },
      ],
      game_accounts: [{ game_name: "XE88", game_username: "XE_leong" }],
      registration_date: day(17, 19),
      total_deposits: 0,
      total_withdrawals: 0,
      notes: "New signup via Telegram, no deposit yet.",
    },
  ];
  const insertedPlayers = await db.insert(players).values(playerRows).returning();
  const p = Object.fromEntries(insertedPlayers.map((x) => [x.username, x]));

  console.log("Seeding game credits…");
  await db.insert(gameCredits).values([
    { player_id: p.ahmad88.player_id, game_name: "Mega888", current_balance: 320.5 },
    { player_id: p.ahmad88.player_id, game_name: "918Kiss", current_balance: 85.0 },
    { player_id: p.jenny_lee.player_id, game_name: "Pussy888", current_balance: 1240.0 },
    { player_id: p.kumar_v.player_id, game_name: "XE88", current_balance: 410.75 },
    { player_id: p.kumar_v.player_id, game_name: "Mega888", current_balance: 0 },
    { player_id: p.wswong.player_id, game_name: "918Kiss", current_balance: 2150.0 },
    { player_id: p.sitinor.player_id, game_name: "Mega888", current_balance: 440.0 },
    { player_id: p.dchong.player_id, game_name: "Pussy888", current_balance: 0 },
    { player_id: p.dchong.player_id, game_name: "XE88", current_balance: 65.25 },
    { player_id: p.mira_a.player_id, game_name: "918Kiss", current_balance: 165.0 },
  ]);

  console.log("Seeding provider BO accounts…");
  await db.insert(providerBoAccounts).values([
    { company_entity_id: company.entity_id, game_name: "Mega888", bo_username: "mpg_mega_01", bo_label: "Mega main", current_credit: 84500.0 },
    { company_entity_id: company.entity_id, game_name: "Pussy888", bo_username: "mpg_pussy_01", bo_label: "Pussy main", current_credit: 42100.5 },
    { company_entity_id: company.entity_id, game_name: "918Kiss", bo_username: "mpg_918_01", bo_label: "918 main", current_credit: 67800.0 },
    { company_entity_id: company.entity_id, game_name: "XE88", bo_username: "mpg_xe_01", bo_label: "XE main", current_credit: 12350.75 },
  ]);

  console.log("Seeding deposits…");
  const depositRows = [
    {
      external_id: "05_Jul_2026_Hello_AHMAD_FAIZAL_*Fund_Transfer_1.0",
      transaction_ref: "DEP-20260705-0001",
      deposit_date: day(5, 10, 12),
      player_id: p.ahmad88.player_id,
      player_username: "ahmad88",
      company_entity_id: company.entity_id,
      deposit_amount: 500,
      bank_name: "Maybank",
      bank_account_number: "157023456789",
      bank_account_holder: "AHMAD FAIZAL BIN RAHMAN",
      bank_description: "Hello AHMAD FAIZAL *Fund Transfer",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 10,
      bonus_amount: 50,
      total_amount: 550,
      selected_game: "Mega888",
      status: "completed" as const,
      matched_at: day(5, 10, 13),
      handled_by_user_id: cs1.user_id,
      game_topup_reference: "MG-TOPUP-88121",
    },
    {
      external_id: "08_Jul_2026_Hello_LEE_XIU_MEI_*Fund_Transfer_2.0",
      transaction_ref: "DEP-20260708-0002",
      deposit_date: day(8, 21, 40),
      player_id: p.jenny_lee.player_id,
      player_username: "jenny_lee",
      company_entity_id: company.entity_id,
      deposit_amount: 1000,
      bank_name: "CIMB",
      bank_account_number: "7009876543",
      bank_account_holder: "LEE XIU MEI",
      bank_description: "IBG GIRO LEE XIU MEI",
      received_into_account_id: cimbDep.account_id,
      bonus_percentage: 20,
      bonus_amount: 200,
      total_amount: 1200,
      selected_game: "Pussy888",
      status: "completed" as const,
      matched_at: day(8, 21, 42),
      handled_by_user_id: cs1.user_id,
      game_topup_reference: "PS-TOPUP-40233",
    },
    {
      external_id: "12_Jul_2026_Hello_WONG_WAI_SHEN_*Fund_Transfer_3.0",
      transaction_ref: "DEP-20260712-0003",
      deposit_date: day(12, 15, 5),
      player_id: p.wswong.player_id,
      player_username: "wswong",
      company_entity_id: company.entity_id,
      deposit_amount: 2000,
      bank_name: "Maybank",
      bank_account_number: "157098761234",
      bank_account_holder: "WONG WAI SHEN",
      bank_description: "Hello WONG WAI SHEN *Fund Transfer",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 30,
      bonus_amount: 600,
      total_amount: 2600,
      selected_game: "918Kiss",
      status: "completed" as const,
      matched_at: day(12, 15, 6),
      handled_by_user_id: cs1.user_id,
      game_topup_reference: "KS-TOPUP-77410",
    },
    {
      external_id: "16_Jul_2026_Hello_KUMAR_VIJAYAN_*Fund_Transfer_1.0",
      transaction_ref: "DEP-20260716-0004",
      deposit_date: day(16, 12, 30),
      player_id: p.kumar_v.player_id,
      player_username: "kumar_v",
      company_entity_id: company.entity_id,
      deposit_amount: 450,
      bank_name: "Public Bank",
      bank_account_number: "4123098765",
      bank_account_holder: "KUMAR A/L VIJAYAN",
      bank_description: "DuitNow KUMAR A/L VIJAYAN",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 5,
      bonus_amount: 22.5,
      total_amount: 472.5,
      selected_game: "XE88",
      status: "approved" as const,
      matched_at: day(16, 12, 33),
      handled_by_user_id: cs1.user_id,
    },
    {
      external_id: "18_Jul_2026_Hello_SITI_NORHALIZA_*Fund_Transfer_1.0",
      transaction_ref: "DEP-20260718-0005",
      deposit_date: day(18, 9, 15),
      player_id: p.sitinor.player_id,
      player_username: "sitinor",
      company_entity_id: company.entity_id,
      deposit_amount: 400,
      bank_name: "BSN",
      bank_account_number: "0410098765432",
      bank_account_holder: "SITI NORHALIZA BINTI ISMAIL",
      bank_description: "IBG SITI NORHALIZA",
      received_into_account_id: cimbDep.account_id,
      bonus_percentage: 10,
      bonus_amount: 40,
      total_amount: 440,
      selected_game: "Mega888",
      status: "processing" as const,
      matched_at: day(18, 9, 18),
      handled_by_user_id: cs1.user_id,
    },
    {
      external_id: "19_Jul_2026_Hello_AMIRA_ZULKIFLI_*Fund_Transfer_1.0",
      transaction_ref: "DEP-20260719-0006",
      deposit_date: day(19, 11, 2),
      player_id: p.mira_a.player_id,
      player_username: "mira_a",
      company_entity_id: company.entity_id,
      deposit_amount: 150,
      bank_name: "Ambank",
      bank_account_number: "8881234567",
      bank_account_holder: "AMIRA BINTI ZULKIFLI",
      bank_description: "DuitNow AMIRA BINTI ZULKIFLI",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 0,
      bonus_amount: 0,
      total_amount: 150,
      selected_game: "918Kiss",
      status: "matched" as const,
      matched_at: day(19, 11, 4),
    },
    {
      transaction_ref: "DEP-20260719-0007",
      deposit_date: day(19, 13, 45),
      player_id: p.leong_ck.player_id,
      player_username: "leong_ck",
      company_entity_id: company.entity_id,
      deposit_amount: 300,
      bank_name: "Maybank",
      bank_account_number: "157011223344",
      bank_account_holder: "LEONG CHEE KEONG",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 0,
      bonus_amount: 0,
      total_amount: 300,
      selected_game: "XE88",
      status: "pending_match" as const,
    },
    {
      external_id: "14_Jul_2026_Hello_CHONG_KA_FAI_*Fund_Transfer_4.0",
      transaction_ref: "DEP-20260714-0008",
      deposit_date: day(14, 22, 10),
      player_id: p.dchong.player_id,
      player_username: "dchong",
      company_entity_id: company.entity_id,
      deposit_amount: 600,
      bank_name: "RHB",
      bank_account_number: "26412345678",
      bank_account_holder: "CHONG KA FAI",
      bank_description: "IBG CHONG KA FAI",
      received_into_account_id: cimbDep.account_id,
      bonus_percentage: 0,
      bonus_amount: 0,
      total_amount: 600,
      selected_game: "Pussy888",
      status: "failed" as const,
      matched_at: day(14, 22, 12),
      handled_by_user_id: cs1.user_id,
    },
    {
      external_id: "19_Jul_2026_Hello_TAN_AH_KOW_*Fund_Transfer_9.0",
      transaction_ref: "DEP-20260719-0009",
      deposit_date: day(19, 14, 20),
      player_username: "unknown",
      company_entity_id: company.entity_id,
      deposit_amount: 250,
      bank_name: "Maybank",
      bank_account_holder: "TAN AH KOW",
      bank_description: "Hello TAN AH KOW *Fund Transfer",
      received_into_account_id: mbbDep.account_id,
      bonus_percentage: 0,
      bonus_amount: 0,
      total_amount: 250,
      status: "pending" as const,
      matched_at: day(19, 14, 21),
    },
  ];
  const insertedDeposits = await db.insert(deposits).values(depositRows).returning();

  console.log("Seeding withdrawals…");
  const insertedWithdrawals = await db
    .insert(withdrawals)
    .values([
      {
        player_id: p.jenny_lee.player_id,
        requested_amount: 1500,
        game_name: "Pussy888",
        credit_pulled_amount: 1500,
        status: "paid" as const,
        handled_by_user_id: cs1.user_id,
        bank_name: "CIMB",
        bank_account_number: "7009876543",
        paid_from_account_id: pbbWdr.account_id,
        paid_at: day(10, 17, 30),
        created_at: day(10, 16, 50),
      },
      {
        player_id: p.wswong.player_id,
        requested_amount: 2800,
        game_name: "918Kiss",
        credit_pulled_amount: 2800,
        status: "paid" as const,
        handled_by_user_id: cs1.user_id,
        bank_name: "Hong Leong",
        bank_account_number: "22398765432",
        paid_from_account_id: hlbWdr.account_id,
        paid_at: day(15, 12, 0),
        created_at: day(15, 10, 20),
      },
      {
        player_id: p.ahmad88.player_id,
        requested_amount: 600,
        game_name: "Mega888",
        credit_pulled_amount: 600,
        status: "credits_pulled" as const,
        handled_by_user_id: cs1.user_id,
        bank_name: "Maybank",
        bank_account_number: "157023456789",
        created_at: day(19, 12, 40),
      },
      {
        player_id: p.kumar_v.player_id,
        requested_amount: 200,
        game_name: "XE88",
        status: "requested" as const,
        bank_name: "Public Bank",
        bank_account_number: "4123098765",
        created_at: day(19, 15, 10),
      },
      {
        player_id: p.dchong.player_id,
        requested_amount: 900,
        game_name: "Pussy888",
        credit_pulled_amount: 0,
        status: "failed" as const,
        handled_by_user_id: cs1.user_id,
        bank_name: "RHB",
        bank_account_number: "26412345678",
        created_at: day(16, 18, 5),
      },
    ])
    .returning();

  console.log("Seeding game transfers…");
  await db.insert(gameTransfers).values([
    {
      player_id: p.ahmad88.player_id,
      from_game: "Mega888",
      to_game: "918Kiss",
      transfer_amount: 100,
      from_game_balance_before: 420.5,
      status: "completed" as const,
      handled_by_user_id: cs1.user_id,
      created_at: day(11, 14, 25),
    },
    {
      player_id: p.kumar_v.player_id,
      from_game: "Mega888",
      to_game: "XE88",
      transfer_amount: 150,
      from_game_balance_before: 150,
      status: "completed" as const,
      created_at: day(17, 10, 5),
    },
    {
      player_id: p.dchong.player_id,
      from_game: "Pussy888",
      to_game: "XE88",
      transfer_amount: 65.25,
      from_game_balance_before: 65.25,
      status: "completed" as const,
      handled_by_user_id: cs1.user_id,
      created_at: day(15, 20, 45),
    },
  ]);

  console.log("Seeding bank transfers…");
  await db.insert(bankTransfers).values([
    {
      from_account_id: mbbDep.account_id,
      to_account_id: pbbWdr.account_id,
      amount: 10000,
      reference: "TRF-20260713-001",
      notes: "Rebalance deposit float to payout account",
      status: "confirmed" as const,
      initiated_by_user_id: admin.user_id,
      confirmed_by_user_id: admin.user_id,
      confirmed_at: day(13, 11, 30),
      created_at: day(13, 11, 0),
    },
    {
      from_account_id: cimbDep.account_id,
      to_account_id: hlbWdr.account_id,
      amount: 5000,
      reference: "TRF-20260719-002",
      notes: "Top up HLB payout float",
      status: "pending_confirmation" as const,
      initiated_by_user_id: admin.user_id,
      expires_at: day(20, 16, 0),
      created_at: day(19, 16, 0),
    },
  ]);

  console.log("Seeding audit transactions…");
  const dep = Object.fromEntries(insertedDeposits.map((d) => [d.transaction_ref, d]));
  await db.insert(transactions).values([
    {
      player_id: p.ahmad88.player_id,
      type: "deposit" as const,
      amount: 550,
      game_name: "Mega888",
      reference_id: dep["DEP-20260705-0001"].deposit_id,
      user_id: cs1.user_id,
      details: { bonus_percentage: 10, topup_ref: "MG-TOPUP-88121" },
      created_at: day(5, 10, 20),
    },
    {
      player_id: p.jenny_lee.player_id,
      type: "deposit" as const,
      amount: 1200,
      game_name: "Pussy888",
      reference_id: dep["DEP-20260708-0002"].deposit_id,
      user_id: cs1.user_id,
      details: { bonus_percentage: 20, topup_ref: "PS-TOPUP-40233" },
      created_at: day(8, 21, 50),
    },
    {
      player_id: p.wswong.player_id,
      type: "deposit" as const,
      amount: 2600,
      game_name: "918Kiss",
      reference_id: dep["DEP-20260712-0003"].deposit_id,
      user_id: cs1.user_id,
      details: { bonus_percentage: 30, topup_ref: "KS-TOPUP-77410" },
      created_at: day(12, 15, 10),
    },
    {
      player_id: p.jenny_lee.player_id,
      type: "withdrawal" as const,
      amount: 1500,
      game_name: "Pussy888",
      reference_id: insertedWithdrawals[0].withdrawal_id,
      user_id: cs1.user_id,
      details: { paid_from: "PBB Payout" },
      created_at: day(10, 17, 30),
    },
    {
      player_id: p.wswong.player_id,
      type: "withdrawal" as const,
      amount: 2800,
      game_name: "918Kiss",
      reference_id: insertedWithdrawals[1].withdrawal_id,
      user_id: cs1.user_id,
      details: { paid_from: "HLB Payout" },
      created_at: day(15, 12, 0),
    },
    {
      player_id: p.ahmad88.player_id,
      type: "credit_pull" as const,
      amount: 600,
      game_name: "Mega888",
      reference_id: insertedWithdrawals[2].withdrawal_id,
      user_id: cs1.user_id,
      created_at: day(19, 12, 55),
    },
    {
      player_id: p.ahmad88.player_id,
      type: "game_transfer" as const,
      amount: 100,
      game_name: "Mega888",
      user_id: cs1.user_id,
      details: { to_game: "918Kiss" },
      created_at: day(11, 14, 25),
    },
    {
      type: "bank_transfer" as const,
      amount: 10000,
      user_id: admin.user_id,
      details: { from: "MBB Deposit A", to: "PBB Payout", reference: "TRF-20260713-001" },
      created_at: day(13, 11, 30),
    },
  ]);

  const counts = await db.execute(sql`
    select
      (select count(*) from players) as players,
      (select count(*) from bank_accounts) as bank_accounts,
      (select count(*) from game_credits) as game_credits,
      (select count(*) from deposits) as deposits,
      (select count(*) from withdrawals) as withdrawals,
      (select count(*) from game_transfers) as game_transfers,
      (select count(*) from bank_transfers) as bank_transfers,
      (select count(*) from provider_bo_accounts) as bo_accounts,
      (select count(*) from transactions) as transactions
  `);
  console.log("✔ Demo data seeded:", counts.rows[0]);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
