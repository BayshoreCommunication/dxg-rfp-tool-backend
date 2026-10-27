/**
 * The standard event-production crew roles a vendor can staff in any room,
 * grouped by department (source: DXG_Operator_Roles.xlsx, October 2026). The
 * vendor form shows them alongside the roles the planner asked for.
 * Keep in step with lib/vendorResponses/operatorRoles.ts in the dashboard.
 */
export const OPERATOR_ROLE_DEPARTMENTS: ReadonlyArray<{ department: string; roles: readonly string[] }> = [
  {
    department: "Leadership & Management",
    roles: ["Executive Producer", "Producer", "Associate Producer", "Production Manager", "Project Manager"],
  },
  {
    department: "Show Control & Direction",
    roles: [
      "Technical Director",
      "Assistant Technical Director",
      "Show Caller",
      "Stage Manager",
      "Assistant Stage Manager",
      "Production Assistant",
    ],
  },
  {
    department: "Audio",
    roles: ["A1 - Audio Engineer", "A2 - Audio Assistant", "Monitor Engineer", "RF Technician", "Audio Technician"],
  },
  {
    department: "Video",
    roles: [
      "V1 - Video Engineer",
      "V2 - Video Assistant",
      "Video Director",
      "Camera Operator",
      "PTZ Operator",
      "LED Technician",
      "LED Processor Operator",
      "Projectionist",
      "Video Technician",
    ],
  },
  {
    department: "Graphics & Media",
    roles: [
      "Graphics Operator",
      "ProPresenter Operator",
      "Media Server Operator (Disguise/d3)",
      "Playback Operator",
      "Teleprompter Operator",
    ],
  },
  {
    department: "Lighting",
    roles: [
      "L1 - Lighting Director",
      "L2 - Lighting Operator",
      "Lighting Designer",
      "Moving Light Technician",
      "Followspot Operator",
    ],
  },
  {
    department: "Networking & IT",
    roles: ["Network Engineer", "Network Technician", "Systems/IT Technician"],
  },
  {
    department: "Rigging & Staging",
    roles: ["Head Rigger", "Rigger", "Ground Rigger", "Staging Lead", "Scenic Carpenter", "Stagehand"],
  },
  {
    department: "Specialty",
    roles: [
      "Drapery/Soft Goods Technician",
      "Power/Electrical Distro Technician",
      "AV Technician (General)",
    ],
  },
];

export const OPERATOR_ROLES: readonly string[] = OPERATOR_ROLE_DEPARTMENTS.flatMap((group) => group.roles);

/**
 * Role ids that existed before the standard list. Mapping onto them keeps
 * vendor drafts that already picked these roles valid.
 */
export const LEGACY_ROLE_IDS: Readonly<Record<string, string>> = {
  "AV Technician (General)": "role-av-technician",
};
