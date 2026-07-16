export interface VendorDocumentStorage {
  upload(input: { localPath: string; objectKey: string }): Promise<string>;
  cleanup(localPath: string): Promise<void>;
}

export interface VendorResponseNotifier {
  notifyPlanner(input: {
    ownerUserId: string;
    organizationId: string;
    proposalId: string;
    responseId: string;
    proposalTitle: string;
    vendorName: string;
    submittedBy: string;
    email: string;
  }): Promise<void>;
}

export interface VendorConfirmationSender {
  send(input: {
    email: string;
    vendorName: string;
    submittedBy: string;
    proposalTitle: string;
    isUpdate: boolean;
  }): Promise<void>;
}
