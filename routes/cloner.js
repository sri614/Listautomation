const express = require("express");
const router = express.Router();
const axios = require("axios");
require("dotenv").config();

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const BASE_URL = process.env.BASE_URL;

const processedEmailsCache = new Set();

async function checkEmailExists(emailName) {
  try {
    const response = await axios.get(`${BASE_URL}`, {
      params: {
        name: emailName,
        limit: 1,
      },
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    return response.data.total > 0;
  } catch (error) {
    console.error(
      "Error checking email existence:",
      error.response?.data || error.message
    );

    return false;
  }
}


async function cloneAndScheduleEmail(
  originalEmailId,
  dayOffset,
  hour,
  minute,
  strategy = "smart"
) {
  try {
  
    const response = await axios.get(`${BASE_URL}/${originalEmailId}`, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const originalEmail = response.data;
    const originalEmailName = originalEmail.name;

    const datePattern = /\d{2} \w{3} \d{4}/;
    const dateMatch = originalEmailName.match(datePattern);
    if (!dateMatch) {
      console.log(`No date found in email name: ${originalEmailName}`);
      return {
        success: false,
        skipped: true,
        reason: "No date in original email name",
      };
    }

    let clonedDate = new Date(dateMatch[0]);
    clonedDate.setDate(clonedDate.getDate() + dayOffset);
    clonedDate.setHours(hour, minute, 0, 0);

    const updatedDate = clonedDate
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
      .replace(",", "");

    const newEmailName = originalEmailName.replace(dateMatch[0], updatedDate);

    if (processedEmailsCache.has(newEmailName)) {
      console.log(`Duplicate detected in cache: ${newEmailName}`);
      return { success: false, skipped: true, reason: "Duplicate in cache" };
    }

    const emailExists = await checkEmailExists(newEmailName);
    if (emailExists) {
      console.log(`Email already exists in HubSpot: ${newEmailName}`);
      return { success: false, skipped: true, reason: "Duplicate in HubSpot" };
    }

    
    processedEmailsCache.add(newEmailName);

    // Clone the email
    const cloneResponse = await axios.post(
      `${BASE_URL}/${originalEmailId}/clone`,
      {},
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const clonedEmail = cloneResponse.data;


    const publishDateTimestamp = clonedDate.getTime();


    const updateEmailData = {
      name: newEmailName,
      mailingIlsListsExcluded: [10469],
      mailingIlsListsIncluded: [39067],
      mailingListsExcluded: [6591],
      mailingListsIncluded: [31189],
      publishImmediately: false,
      publishDate: publishDateTimestamp,
      isGraymailSuppressionEnabled: false,
    };

    await axios.put(`${BASE_URL}/${clonedEmail.id}`, updateEmailData, {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`Successfully cloned email to ${newEmailName}`);
    return {
      success: true,
      emailId: clonedEmail.id,
      emailName: newEmailName,
      scheduledTime: clonedDate.toISOString(),
    };
  } catch (error) {
    console.error(
      `Error cloning email ${originalEmailId}:`,
      error.response?.data || error.message
    );
    return {
      success: false,
      error: error.message,
      details: error.response?.data,
    };
  }
}


async function EmailCloner(emailIds, cloningCount, strategy = "smart") {
  try {
    let stats = {
      totalAttempted: 0,
      successfullyCloned: 0,
      duplicatesSkipped: 0,
      errors: 0,
      clonedEmails: [],
    };

    for (let day = 1; day <= cloningCount; day++) {
      let minuteCounter = 0;
      let morningSlotsUsed = 0;
      const MAX_MORNING_SLOTS = 12; 

      for (let i = 0; i < emailIds.length; i++) {
        const emailId = emailIds[i];
        let hour, minute;

        switch (strategy) {
          case "morning":
            hour = 11;
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          case "afternoon":
            hour = 16;
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          case "custom":
            hour = 11; 
            minute = minuteCounter;
            minuteCounter += 5;
            break;

          default: 
            if (morningSlotsUsed < MAX_MORNING_SLOTS) {
              hour = 11;
              minute = minuteCounter;
              minuteCounter += 5;
              morningSlotsUsed++;
            } else {
              hour = 16;
              minute = minuteCounter - MAX_MORNING_SLOTS * 5;
            }
        }

        stats.totalAttempted++;
        console.log(
          `Processing email ${emailId} (Day ${day}) at ${hour}:${minute
            .toString()
            .padStart(2, "0")}`
        );

        const result = await cloneAndScheduleEmail(
          emailId,
          day,
          hour,
          minute,
          strategy
        );

        if (result.success) {
          stats.successfullyCloned++;
          stats.clonedEmails.push({
            id: result.emailId,
            name: result.emailName,
            time: result.scheduledTime,
          });
        } else if (result.skipped) {
          stats.duplicatesSkipped++;
        } else {
          stats.errors++;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000)); // Rate limiting
      }
    }

    return {
      success: true,
      message: `Email cloning completed. ${stats.successfullyCloned} cloned, ${stats.duplicatesSkipped} duplicates skipped, ${stats.errors} errors.`,
      stats: stats,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to complete cloning process: ${error.message}`,
      error: error,
    };
  }
}


router.post("/clone-emails", async (req, res) => {
  const { emailIds, cloningCount, strategy = "smart" } = req.body;

  // input validation
  if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Please provide at least one valid email ID",
    });
  }

  if (!cloningCount || isNaN(cloningCount)) {
    return res.status(400).json({
      success: false,
      message: "Please provide a valid cloning count",
    });
  }

  try {

    processedEmailsCache.clear();

    const result = await EmailCloner(
      emailIds,
      parseInt(cloningCount, 10),
      strategy
    );

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        stats: result.stats,
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("Cloning error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to clone emails.",
      error: error.message,
    });
  }
});

router.get("/cloner", async (req, res) => {
  try {
    res.status(200).render("cloner", {
      pageTitle: "Email cloning",
       activePage:"email cloning",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to get emails" });
  }
});

module.exports = router;
