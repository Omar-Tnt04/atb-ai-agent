const mockComplaints = require('../../data/mockComplaints');

const createComplaintReference = () => {
  const year = new Date().getFullYear();
  const sequence = String(mockComplaints.length + 1).padStart(3, '0');

  return `CMP-${year}-${sequence}`;
};

const canViewComplaint = (user, complaint) => {
  return (
    user.role === 'SUPPORT_AGENT' ||
    user.role === 'ADMIN' ||
    complaint.userId === user.id
  );
};

module.exports = {
  name: 'mockComplaintConnector',
  description: 'Demo complaint connector for MVP',
  operations: {
    createComplaint: async ({ user, payload }) => {
      const complaint = {
        reference: createComplaintReference(),
        userId: user.id,
        customerName: user.fullName,
        category: payload.category,
        description: payload.description,
        status: 'open',
        createdAt: new Date().toISOString(),
      };

      mockComplaints.push(complaint);

      return {
        success: true,
        data: {
          complaint,
        },
      };
    },

    listComplaints: async ({ user }) => ({
      success: true,
      data: {
        complaints:
          user.role === 'SUPPORT_AGENT' || user.role === 'ADMIN'
            ? mockComplaints
            : mockComplaints.filter((complaint) => complaint.userId === user.id),
      },
    }),

    checkComplaintStatus: async ({ user, payload }) => {
      const complaint = mockComplaints.find(
        (mockComplaint) => mockComplaint.reference === payload.reference,
      );

      if (!complaint || !canViewComplaint(user, complaint)) {
        return {
          success: false,
          status: 'not_found',
          message: 'Complaint not found',
        };
      }

      return {
        success: true,
        data: {
          complaint,
        },
      };
    },
  },
};
