import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique
} from "typeorm";
import { DEFAULT_USER_ROLE } from "../lib/user-roles.js";
import type { UserRole } from "../lib/user-roles.js";

@Entity("users")
@Unique("UQ_users_walletAddress", ["walletAddress"])
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 128 })
  walletAddress!: string;

  @Index("IDX_users_email")
  @Column({ type: "varchar", length: 128, nullable: true })
  email?: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  alias?: string;

  @Column({ type: "varchar", length: 32, default: DEFAULT_USER_ROLE })
  role!: UserRole;

  @Column({ type: "boolean", default: true })
  isActive!: boolean;

  /**
   * Soft-delete marker (#1333). Null means active. Set by `DELETE /users/me`.
   * Deliberately NOT applied to `TransactionRecord` or `AuditLog` — those
   * are financial/audit history and must survive a user deleting their
   * account, so this column exists only on user-owned, non-financial
   * records. See `lib/soft-delete.ts` for the retention policy.
   */
  @Column({ type: "timestamptz", nullable: true })
  deletedAt!: Date | null;

  /**
   * Incremented to invalidate every outstanding wallet JWT for this user
   * (#1446). Tokens carry it as the `sv` claim; see `services/session-revocation.ts`.
   */
  @Column({ type: "integer", default: 0 })
  sessionVersion!: number;

  /** When the user confirmed their email address (#1443). Null = unverified. */
  @Column({ type: "timestamptz", nullable: true })
  emailVerifiedAt!: Date | null;

  @CreateDateColumn({ type: "timestamp" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}