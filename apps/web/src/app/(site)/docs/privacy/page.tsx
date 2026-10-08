import { DocumentPage, documentMetadata } from '../document-page';

export const metadata = documentMetadata('privacy');

export default function PrivacyPage() {
  return <DocumentPage slug="privacy" />;
}
