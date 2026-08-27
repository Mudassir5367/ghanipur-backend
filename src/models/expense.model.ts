import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/** Expense tracking (§20). Extensible foundation for future cost/profit analysis. */
const expenseSchema = new Schema(
  {
    shopId: { type: Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    category: { type: String, required: true, trim: true }, // dynamic: Rent, Electricity, Salary…
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, default: 'CASH' },
    description: { type: String, default: '' },
    isRecurring: { type: Boolean, default: false },
    incurredAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

expenseSchema.index({ shopId: 1, incurredAt: -1 });
expenseSchema.index({ shopId: 1, category: 1 });

export type ExpenseDoc = InferSchemaType<typeof expenseSchema> & { _id: Types.ObjectId };

export const Expense = model('Expense', expenseSchema);
