import mongoose, { Schema, Document } from 'mongoose';

export interface IEscalationLetter extends Document {
  complaintId: mongoose.Types.ObjectId;
  escalationLetter: string;
  regulatorName: string | null;
  regulatorContact: string | null;
  filingInstructions: string | null;
  regulatorVerified: boolean;
  createdAt: Date;
}

const EscalationLetterSchema = new Schema<IEscalationLetter>({
  complaintId: {
    type: Schema.Types.ObjectId,
    ref: 'Complaint',
    required: [true, 'Complaint ID is required'],
    unique: true,
  },
  escalationLetter: {
    type: String,
    required: [true, 'Escalation letter content is required'],
  },
  regulatorName: {
    type: String,
    default: null,
  },
  regulatorContact: {
    type: String,
    default: null,
  },
  filingInstructions: {
    type: String,
    default: null,
  },
  regulatorVerified: {
    type: Boolean,
    default: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.models.EscalationLetter || mongoose.model<IEscalationLetter>('EscalationLetter', EscalationLetterSchema);
