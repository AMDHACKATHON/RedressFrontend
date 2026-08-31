import mongoose, { Schema, Document } from 'mongoose';

export interface ILetter extends Document {
  complaintId: mongoose.Types.ObjectId;
  letter: string;
  recipient: string;
  recipientContact: string | null;
  channel: string;
  regulatorName: string | null;
  regulatorContact: string | null;
  regulatorCountry: string | null;
  regulatorVerified: boolean;
  createdAt: Date;
}

const LetterSchema = new Schema<ILetter>({
  complaintId: {
    type: Schema.Types.ObjectId,
    ref: 'Complaint',
    required: [true, 'Complaint ID is required'],
    unique: true,
  },
  letter: {
    type: String,
    required: [true, 'Letter content is required'],
  },
  recipient: {
    type: String,
    required: [true, 'Recipient is required'],
  },
  recipientContact: {
    type: String,
    default: null,
  },
  channel: {
    type: String,
    required: [true, 'Channel is required'],
  },
  regulatorName: {
    type: String,
    default: null,
  },
  regulatorContact: {
    type: String,
    default: null,
  },
  regulatorCountry: {
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

export default mongoose.models.Letter || mongoose.model<ILetter>('Letter', LetterSchema);
